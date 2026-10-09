import * as z from 'zod/mini';
import type { MachineProvisionerCheckResultV1, MachineProvisionerOptionsResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { CuaNativeClient, CuaNativeOutcome } from './nativeClient.js';
import { CuaLocalOptionsQueryV1Schema, type CuaLocalLaunchV1, type CuaLocalOptionsQueryV1 } from './schemas.js';

// Immutable read contract: trycua/cua@2bce4442c107fc34c45b374b29a35d09f630fd83,
// cua-cli/src/lib.rs RuntimeCmd::Doctor / ImagesCmd::Ls, catalog.rs row(),
// cua-vmm/src/auto.rs DoctorReport, and libs/images/sandbox-images.json.
// `image ls` is a different, authenticated Fleet read and must not replace
// `images ls`. No setup/start/download or cloud command is part of these reads.
const vendorSource = 'https://raw.githubusercontent.com/trycua/cua/2bce4442c107fc34c45b374b29a35d09f630fd83';
const arch = z.enum(['amd64', 'arm64']);
const digest = z.string().check(z.regex(/^sha256:[a-f0-9]{64}$/u));
const version = z.optional(z.nullable(z.string()));
const doctorSchema = z.object({
    host: z.object({ os: z.enum(['macos', 'linux', 'windows']), arch: z.enum(['x86_64', 'aarch64']),
        kvm: z.boolean(), accel: z.object({ x86_64: z.enum(['kvm', 'hvf', 'whpx', 'tcg']), aarch64: z.enum(['kvm', 'hvf', 'whpx', 'tcg']) }) }),
    backends: z.array(z.object({ backend: z.string(), ready: z.boolean(), provisionable: z.boolean() })),
    qemu: z.object({ version }), lume: z.object({ version }),
    container: z.object({ reachable: z.boolean(), gvisor: z.boolean(), runtimes: z.array(z.string()) }),
});
// Qualified OCI references only: never disclose native endpoint URLs, userinfo,
// query strings, commands or arbitrary diagnostic text as an image choice.
const imageReference = z.string().check(z.regex(/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)?(?:@sha256:[a-f0-9]{64})?$/u));
const imageSchema = z.object({
    ref: imageReference, os: z.enum(['linux', 'macos', 'windows']), arch: z.array(arch),
    local: z.nullable(z.string()), published: z.boolean(), spacesd: z.boolean(),
    browser_tools: z.optional(z.boolean()), digest: z.optional(z.nullable(digest)), sizes: z.optional(z.unknown()),
});
const sizesSchema = z.object({ digest, platforms: z.array(z.object({ arch,
    disk: z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER)) })) });

type UnknownReason = Extract<CuaNativeOutcome<unknown>, { kind: 'unknown' }>['reason'] | 'not_reported' | 'image_digest_mismatch';
export type CuaNativeFact<T> = Readonly<{ kind: 'known'; value: T }> | Readonly<{ kind: 'unknown'; reason: UnknownReason }>;
export type CuaNativeRuntimeFact = Readonly<{
    id: CuaLocalLaunchV1['runtimeId']; ready: boolean; provisionable: boolean; version?: string;
}>;
export type CuaNativeDoctorFacts = Readonly<{
    host: z.infer<typeof doctorSchema>['host']; runtimes: readonly CuaNativeRuntimeFact[];
}>;
export type CuaNativeImageFacts = Readonly<{
    imageId: string; os: 'linux' | 'macos' | 'windows'; architectures: readonly ('amd64' | 'arm64')[];
    runtimeIds: readonly CuaLocalLaunchV1['runtimeId'][]; spacesd: boolean; browserTools?: boolean;
    digest?: string;
    disk: CuaNativeFact<readonly Readonly<{ arch: 'amd64' | 'arm64'; bytes: number }>[]>;
}>;

function known<T>(value: T): CuaNativeFact<T> { return { kind: 'known', value }; }
function unknown(reason: UnknownReason): Readonly<{ kind: 'unknown'; reason: UnknownReason }> { return { kind: 'unknown', reason }; }
function runtimeVersion(value: string | null | undefined) {
    // QEMU prints a whole --version line. Export the numeric version only,
    // never paths, environment values or other native free-form output.
    return value?.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/u)?.[0];
}

function projectDoctor(value: unknown): CuaNativeFact<CuaNativeDoctorFacts> {
    const parsed = doctorSchema.safeParse(value);
    if (!parsed.success) return unknown('response');
    const report = parsed.data;
    const backend = (id: string) => report.backends.find((entry) => entry.backend === id);
    const qemu = backend('qemu');
    const lume = backend('lume');
    const container = backend('container');
    const managed = backend('managed');
    const containerReady = container?.ready === true && report.container.reachable;
    const qemuVersion = runtimeVersion(report.qemu.version);
    const lumeVersion = runtimeVersion(report.lume.version);
    return known({ host: report.host, runtimes: [
        { id: 'qemu', ready: qemu?.ready === true, provisionable: qemu?.provisionable === true,
            ...(qemuVersion ? { version: qemuVersion } : {}) },
        { id: 'lume', ready: lume?.ready === true, provisionable: lume?.provisionable === true,
            ...(lumeVersion ? { version: lumeVersion } : {}) },
        { id: 'runc', ready: containerReady, provisionable: false },
        { id: 'gvisor', ready: (containerReady && report.container.gvisor && report.container.runtimes.includes('runsc')) || managed?.ready === true,
            provisionable: container?.provisionable === true || managed?.provisionable === true },
    ] } satisfies CuaNativeDoctorFacts);
}

function projectImages(value: unknown): CuaNativeFact<readonly CuaNativeImageFacts[]> {
    if (!Array.isArray(value)) return unknown('response');
    const images: CuaNativeImageFacts[] = [];
    for (const row of value) {
        const parsed = imageSchema.safeParse(row);
        if (!parsed.success || !parsed.data.published) continue;
        const image = parsed.data;
        const runtimeIds: CuaLocalLaunchV1['runtimeId'][] = image.local === 'container' ? ['runc', 'gvisor']
            : image.local === 'qemu' || image.local === 'lume' ? [image.local] : [];
        if (runtimeIds.length === 0) continue;
        let disk: CuaNativeImageFacts['disk'] = unknown('not_reported');
        const sizes = sizesSchema.safeParse(image.sizes);
        if (sizes.success) {
            disk = image.digest !== sizes.data.digest ? unknown('image_digest_mismatch')
                : known(sizes.data.platforms.filter((entry) => image.arch.includes(entry.arch))
                    .map((entry) => ({ arch: entry.arch, bytes: entry.disk })));
        } else if (image.sizes !== null && typeof image.sizes === 'object' && 'digest' in image.sizes
            && image.sizes.digest !== image.digest) {
            disk = unknown('image_digest_mismatch');
        }
        images.push({ imageId: image.ref, os: image.os, architectures: image.arch, runtimeIds, spacesd: image.spacesd,
            ...(image.browser_tools === undefined ? {} : { browserTools: image.browser_tools }),
            ...(image.digest ? { digest: image.digest } : {}), disk });
    }
    return known(images);
}

export function createCuaNativeFacts(native: CuaNativeClient) {
    async function readDoctor(signal?: AbortSignal): Promise<CuaNativeFact<CuaNativeDoctorFacts>> {
        // CLI open() otherwise follows CUA_DAEMON/native daemon discovery and
        // its token. Embedded doctor uses the selected controller in process;
        // unlike sandbox commands it opens without Fleet session credentials.
        const result = await native.json(['--embedded', 'runtime', 'doctor'], signal);
        return result.kind === 'success' ? projectDoctor(result.value) : unknown(result.reason);
    }
    async function readImages(signal?: AbortSignal): Promise<CuaNativeFact<readonly CuaNativeImageFacts[]>> {
        const result = await native.json(['images', 'ls'], signal);
        return result.kind === 'success' ? projectImages(result.value) : unknown(result.reason);
    }
    return {
        async read(signal?: AbortSignal) {
            const [doctor, images] = await Promise.all([readDoctor(signal), readImages(signal)]);
            return { doctor, images,
                // Doctor/catalog do not report the installed Cua CLI version,
                // free CPU/RAM/disk, capture qualification or billing amounts.
                nativeVersion: unknown('not_reported'), headroom: unknown('not_reported'),
                capture: unknown('not_reported'), prices: unknown('not_reported'),
                license: { component: 'cua-spacesd', license: 'FSL-1.1-MIT',
                    source: `${vendorSource}/libs/cua-spacesd/LICENSE`, qualification: 'unqualified' as const },
            };
        },
        async check(signal?: AbortSignal): Promise<MachineProvisionerCheckResultV1> {
            const doctor = await readDoctor(signal);
            if (doctor.kind === 'unknown') return { available: false, code: 'native_facts_unknown' };
            return doctor.value.runtimes.some((runtime) => runtime.ready)
                ? { available: true } : { available: false, code: 'native_runtime_unavailable' };
        },
        async options(signal?: AbortSignal, input: CuaLocalOptionsQueryV1 = {}, localId: 'local-sandbox' | 'local-space' = 'local-sandbox'): Promise<MachineProvisionerOptionsResultV1> {
            const selectors = CuaLocalOptionsQueryV1Schema.parse(input);
            const [doctor, images] = await Promise.all([readDoctor(signal), readImages(signal)]);
            if (doctor.kind === 'unknown' || images.kind === 'unknown') return { choices: [] };
            const nativeArch = doctor.value.host.arch === 'x86_64' ? 'amd64' : 'arm64';
            // One native choice owner serves both local leaves. The catalog has
            // no CPU/RAM presets: complete launches require reviewed selectors.
            return { choices: images.value.flatMap((image) => image.runtimeIds
                .filter((runtime) => (!selectors.runtimeId || runtime === selectors.runtimeId)
                    && (!selectors.imageId || selectors.imageId === image.imageId))
                .map((runtimeId) => {
                    const disk = image.disk.kind === 'known' ? image.disk.value.find((value) => value.arch === nativeArch)?.bytes : undefined;
                    const size = selectors.size;
                    const sizing = !size || (size.memoryBytes % 1024 ** 2 === 0
                        && (localId === 'local-space' && (runtimeId === 'qemu' || runtimeId === 'lume')
                            ? size.diskBytes % 1024 ** 3 === 0 && size.diskBytes / 1024 ** 3 <= 4_294_967_295
                            : size.diskBytes === disk));
                    const available = image.spacesd && image.os !== 'windows' && image.architectures.includes(nativeArch)
                        && doctor.value.runtimes.some((value) => value.id === runtimeId && value.ready) && sizing;
                    return { id: `${runtimeId}:${image.imageId}`, title: `${image.imageId} (${runtimeId})`, available,
                        nativeFacts: { image: { id: image.imageId, title: image.imageId },
                            location: { id: runtimeId, title: runtimeId },
                            ...(size ? { size: { id: `${size.cpu}:${size.memoryBytes}:${size.diskBytes}`, title: `${size.cpu} CPU`,
                                cpuCores: size.cpu, memoryBytes: size.memoryBytes, diskBytes: size.diskBytes } } : {}) },
                        ...(size && available ? { launch: { on: 'local' as const, runtimeId, imageId: image.imageId, size } } : {}) };
                })) };
        },
    };
}
