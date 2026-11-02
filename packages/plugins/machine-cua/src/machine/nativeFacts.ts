import * as z from 'zod/mini';
import type { MachineProvisionerCheckResultV1, MachineProvisionerOptionsResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { CuaNativeClient, CuaNativeOutcome } from './nativeClient.js';
import { CuaLocalOptionsQueryV1Schema, CuaNativeImageRefSchema, type CuaLocalLaunchV1, type CuaLocalOptionsQueryV1 } from './schemas.js';

// Immutable read contract: trycua/cua@2bce4442c107fc34c45b374b29a35d09f630fd83,
// cua-cli/src/lib.rs RuntimeCmd::Doctor / ImagesCmd::Ls, catalog.rs row(),
// cua-vmm/src/auto.rs DoctorReport, and libs/images/sandbox-images.json.
// No setup/start/download or cloud command is part of these reads.
const vendorSource = 'https://raw.githubusercontent.com/trycua/cua/2bce4442c107fc34c45b374b29a35d09f630fd83';
const arch = z.enum(['amd64', 'arm64']);
const digest = z.string().check(z.regex(/^sha256:[a-f0-9]{64}$/u));
const version = z.optional(z.nullable(z.string()));
const doctorSchema = z.object({
    host: z.object({ os: z.enum(['macos', 'linux', 'windows']), arch: z.enum(['x86_64', 'aarch64']),
        kvm: z.boolean(), accel: z.object({ x86_64: z.enum(['kvm', 'hvf', 'whpx', 'tcg']), aarch64: z.enum(['kvm', 'hvf', 'whpx', 'tcg']) }) }),
    backends: z.array(z.object({ backend: z.string(), ready: z.boolean(), provisionable: z.boolean() })),
    qemu: z.object({ version }),
    container: z.object({ reachable: z.boolean(), gvisor: z.boolean(), runtimes: z.array(z.string()) }),
});
// Qualified OCI references only: never disclose native endpoint URLs, userinfo,
// query strings, commands or arbitrary diagnostic text as an image choice.
const imageReference = z.string().check(z.regex(/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)?(?:@sha256:[a-f0-9]{64})?$/u));
const imageSchema = z.object({
    ...CuaNativeImageRefSchema.shape, ref: imageReference, os: z.enum(['linux', 'macos', 'windows']), arch: z.array(arch),
    local: z.nullable(z.string()), spacesd: z.boolean(),
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
    const container = backend('container');
    const managed = backend('managed');
    const containerReady = container?.ready === true && report.container.reachable;
    const qemuVersion = runtimeVersion(report.qemu.version);
    return known({ host: report.host, runtimes: [
        { id: 'qemu', ready: qemu?.ready === true, provisionable: qemu?.provisionable === true,
            ...(qemuVersion ? { version: qemuVersion } : {}) },
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
            : image.local === 'qemu' ? ['qemu'] : [];
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
        // unlike sandbox commands it opens without a Cua login.
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
            const dimensions: MachineProvisionerOptionsResultV1['dimensions'] = { size: [], image: [], location: [], network: [], duration: [] };
            if (doctor.kind === 'unknown' || images.kind === 'unknown') return { dimensions };
            const nativeArch = doctor.value.host.arch === 'x86_64' ? 'amd64' : 'arm64';
            const size = selectors.size;
            const sizeIdentity = size ? { id: `${size.cpu}:${size.memoryBytes}:${size.diskBytes ?? 'image'}`, title: `${size.cpu} CPU` } : undefined;
            const selectedImages = images.value.filter(image => !selectors.imageId || selectors.imageId === image.imageId);
            const runtimes = [...new Set(selectedImages.flatMap(image => image.runtimeIds))]
                .filter(runtimeId => !selectors.runtimeId || runtimeId === selectors.runtimeId);
            const diskFor = (image: CuaNativeImageFacts) => image.disk.kind === 'known'
                ? image.disk.value.find(value => value.arch === nativeArch)?.bytes : undefined;
            function sizing(image: CuaNativeImageFacts, runtimeId: CuaLocalLaunchV1['runtimeId']) {
                if (!size) return true;
                const disk = diskFor(image), diskBytes = size.diskBytes ?? disk;
                // Preserve the native sizing qualification used at admission.
                return diskBytes !== undefined && (localId === 'local-space' && runtimeId === 'qemu'
                    ? diskBytes % 1024 ** 3 === 0 && diskBytes / 1024 ** 3 <= 4_294_967_295
                    : diskBytes === disk);
            }
            return {
                ...(size ? { base: { launch: { on: 'local' } } } : {}),
                dimensions: {
                    ...dimensions,
                    size: size && sizeIdentity ? [{ ...sizeIdentity,
                        assignments: [{ path: 'size.cpu', value: size.cpu }, { path: 'size.memoryBytes', value: size.memoryBytes },
                            ...(size.diskBytes === undefined ? [] : [{ path: 'size.diskBytes', value: size.diskBytes }])],
                        available: size.memoryBytes % 1024 ** 2 === 0,
                        nativeFacts: { size: { ...sizeIdentity, cpuCores: size.cpu, memoryBytes: size.memoryBytes,
                            ...(size.diskBytes === undefined ? {} : { diskBytes: size.diskBytes }) } }, }] : [],
                    image: selectedImages.map(image => {
                        const diskBytes = diskFor(image);
                        return { id: image.imageId, title: image.imageId,                            assignments: [{ path: 'imageId', value: image.imageId },
                                ...(size && size.diskBytes === undefined && diskBytes !== undefined ? [{ path: 'size.diskBytes', value: diskBytes }] : [])],
                            available: image.spacesd && image.os !== 'windows' && image.architectures.includes(nativeArch),
                            nativeFacts: { image: { id: image.imageId, title: image.imageId },
                                ...(sizeIdentity && size?.diskBytes === undefined && diskBytes !== undefined
                                    ? { size: { ...sizeIdentity, diskBytes } } : {}) }, };
                    }),
                    location: runtimes.map(runtimeId => ({ id: runtimeId, title: runtimeId,
                        assignments: [{ path: 'runtimeId', value: runtimeId }],
                        // Native readiness cannot qualify a missing detached guest-daemon carrier.
                        available: runtimeId !== 'gvisor' && doctor.value.runtimes.some(value => value.id === runtimeId && value.ready),
                        nativeFacts: { location: { id: runtimeId, title: runtimeId } }, })), },
                constraints: runtimes.map(runtimeId => ({ when: { dimension: 'location' as const, optionIds: [runtimeId] },
                    requires: { dimension: 'image' as const, optionIds: selectedImages.filter(image => image.runtimeIds.includes(runtimeId)
                        && sizing(image, runtimeId)).map(image => image.imageId) } })), };
        },
    };
}
