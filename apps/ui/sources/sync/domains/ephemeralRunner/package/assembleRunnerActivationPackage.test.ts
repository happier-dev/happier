import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TextReader, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js';
import { assembleRunnerActivationPackage } from './assembleRunnerActivationPackage';
import { exportRunnerActivationPackage } from './exportRunnerActivationPackage';
import { createRunnerActivationKeyCustody, readRunnerActivationSigningKey, removeRunnerActivationKeyCustody } from '../runnerActivationKeyCustody';
import { readRunnerActivationExportFile, type RunnerActivationCustody } from '../runnerActivationCustody';
import { RunnerActivationBindingV1Schema } from '@happier-dev/protocol/ephemeralRunner/activation';
import type { RunnerArtifactArchiveMetadataV1 } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import tweetnacl from 'tweetnacl';
import { signMachineInstallationProof, type HomeConnectionDescriptorV1 } from '@happier-dev/protocol';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

const platform = vi.hoisted(() => ({ OS: 'web' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return { ...await createReactNativeWebMock(), Platform: platform };
});

const fs = await vi.hoisted(async () => {
    const { createExpoFileSystemFileMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    return createExpoFileSystemFileMock();
});
const sharing = vi.hoisted(() => ({ available: true, failed: false, onAvailability: undefined as (() => void) | undefined, observed: vi.fn() }));
vi.mock('expo-file-system', () => fs.module);
vi.mock('expo-sharing', () => ({
    isAvailableAsync: async () => { sharing.onAvailability?.(); return sharing.available; },
    shareAsync: async (uri: string, options?: { mimeType?: string; UTI?: string }) => {
        await sharing.observed(uri, undefined, options?.mimeType, options?.UTI);
        if (sharing.failed) throw new Error('native_share_failed');
    },
}));
// The native bridge is the recipient/OS boundary; the sharing and cache owners stay real.
vi.mock('expo-modules-core', async (importOriginal) => ({
    ...await importOriginal<typeof import('expo-modules-core')>(),
    requireOptionalNativeModule: (name: string) => name === 'HappierFileActions' ? {
        shareFile: async (uri: string, name: string, mimeType?: string) => {
            await sharing.observed(uri, name, mimeType);
            if (sharing.failed) throw new Error('native_share_failed');
        },
    } : null,
}));

const secureValues = vi.hoisted(() => new Map<string, string>());
const AUTHORING_COMMITMENT = 'A'.repeat(43);
// Native OS key storage is the boundary; the real custody repository remains active.
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => secureValues.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { secureValues.set(key, value); },
    deleteItemAsync: async (key: string) => { secureValues.delete(key); },
}));

// OpenSSL is the release-signing boundary; the verifier uses its real independent implementation.
async function fixture(
    entries: readonly [string, string, number][] = [['happier-runner', 'immutable executable fixture', 0o100755]],
    target = 'linux-x64',
    alterMetadata?: (metadata: RunnerArtifactArchiveMetadataV1) => RunnerArtifactArchiveMetadataV1,
) {
    const archive = new ZipWriter(new Uint8ArrayWriter());
    for (const [name, text, mode] of entries) {
        await archive.add(name, new TextReader(text), { level: 6, useWebWorkers: false, useCompressionStream: false, versionMadeBy: 0x031e, externalFileAttributes: mode << 16 });
    }
    const bytes = await archive.close();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const artifactName = `happier-runner-v0.3.0-${target}.zip`;
    const observedMetadata: RunnerArtifactArchiveMetadataV1 = { sizeBytes: bytes.byteLength, entries: entries.map(([path, text, mode]) => ({
        path, kind: (mode & 0o170000) === 0o120000 ? 'symlink' : 'file', sizeBytes: new TextEncoder().encode(text).byteLength,
        mode: mode & 0o7777,
        ...((mode & 0o170000) === 0o120000 ? { linkTarget: text } : {}),
    })) };
    const metadata = alterMetadata?.(observedMetadata) ?? observedMetadata;
    const checksumsText = `${sha256}  ${artifactName}\n# happier-artifact-v1 ${JSON.stringify({ name: artifactName, ...metadata })}\n`;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicBytes = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const secretBytes = Buffer.concat([privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32), publicBytes]);
    const keyId = Buffer.alloc(8, 9);
    const signature = sign(null, Buffer.from(checksumsText), privateKey);
    const comment = 'fixture';
    const checksumsSignatureFile = ['untrusted comment: fixture', Buffer.concat([Buffer.from('Ed'), keyId, signature]).toString('base64'), `trusted comment: ${comment}`, sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey).toString('base64')].join('\n');
    const minisignPublicKeyFile = `untrusted comment: fixture\n${Buffer.concat([Buffer.from('Ed'), keyId, publicBytes]).toString('base64')}`;
    const activationFile = {
        v: 1,
        home: { v: 1, homeServerIdentityId: 'srv_fixture_home', canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example.test' }] } satisfies HomeConnectionDescriptorV1,
        activation: { id: '00000000-0000-4000-8000-000000000008', signingPrivateKeyBase64Url: secretBytes.toString('base64url'), creatorAccountId: 'creator', creatorTokenEpoch: 0, activationExpiresAt: null, workspace: { kind: 'choose_on_endpoint' as const }, sessionId: 'session', machineId: 'machine', authoringCommitment: AUTHORING_COMMITMENT, artifact: { product: 'happier-runner', version: '0.3.0', target, sha256 }, endpointFactsRecipient: { mode: 'plain', creatorAccountId: 'creator' } },
    };
    const chunks: Uint8Array[] = [];
    let closed = false;
    let cleaned = false;
    return {
        input: { activationFile, artifactName, source: { kind: 'memory' as const, bytes }, artifactMetadata: metadata, checksumsText, checksumsSignatureFile, minisignPublicKeyFile, destination: { writeBytes: async (chunk: Uint8Array) => { chunks.push(chunk.slice()); }, close: async () => { closed = true; }, cleanup: async () => { chunks.length = 0; cleaned = true; } } },
        output: () => new Uint8Array(Buffer.concat(chunks)), closed: () => closed, cleaned: () => cleaned,
    };
}

async function exportFixture(f: Awaited<ReturnType<typeof fixture>>) {
    const values = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    } });
    const scope = { serverId: 'home-a', accountId: 'creator' };
    const key = await createRunnerActivationKeyCustody(scope);
    const activation = f.input.activationFile.activation;
    const custody: RunnerActivationCustody = { scope, key, binding: RunnerActivationBindingV1Schema.parse({
        activationId: key.activationId,
        homeServerIdentityId: f.input.activationFile.home.homeServerIdentityId,
        creatorAccountId: activation.creatorAccountId,
        creatorTokenEpoch: activation.creatorTokenEpoch,
        activationExpiresAt: activation.activationExpiresAt,
        workspace: activation.workspace,
        sessionId: activation.sessionId,
        machineId: activation.machineId,
        activationSigningPublicKey: key.activationSigningPublicKey,
        authoringCommitment: activation.authoringCommitment,
        artifact: activation.artifact,
        endpointFactsRecipient: activation.endpointFactsRecipient,
    }) };
    return { ...f.input, custody, home: f.input.activationFile.home,
        projection: { ...custody.binding, draftId: 'draft-a', authoringCommitment: AUTHORING_COMMITMENT, state: 'pending', closeReason: null, claim: null, endpointFacts: null } };
}

describe('creator-local Runner package assembly', () => {
    it('does not expose an expired package key or delete custody before acknowledged closure', async () => {
        const input = await exportFixture(await fixture());
        try {
            const activationExpiresAt = Date.now() - 1;
            const custody = { ...input.custody, binding: { ...input.custody.binding, activationExpiresAt } };
            await expect(readRunnerActivationExportFile({ ...input, custody,
                projection: { ...input.projection, activationExpiresAt },
            })).rejects.toThrow('runner_activation_expired');
            expect(await readRunnerActivationSigningKey(custody.scope, custody.key)).toBeTruthy();
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it('disables export after a verified claim while retaining the activation proof key for review', async () => {
        const input = await exportFixture(await fixture());
        try {
            const { custody } = input;
            const secret = await readRunnerActivationSigningKey(custody.scope, custody.key);
            const installation = tweetnacl.sign.keyPair();
            const payload = {
                v: 1, purpose: 'happier.ephemeral-session-runner.claim', binding: custody.binding,
                runnerBoxPublicKey: encodeBase64(tweetnacl.box.keyPair().publicKey, 'base64url'),
                installation: {
                    installationId: 'fixture-installation',
                    publicKey: encodeBase64(installation.publicKey, 'base64url'),
                    proof: signMachineInstallationProof({ payload: {
                        version: 1, installationId: 'fixture-installation', machineId: custody.binding.machineId,
                        accountId: custody.binding.creatorAccountId,
                    }, privateKey: installation.secretKey }),
                },
                protocolEpoch: 1,
            };
            const claim = { payload, signature: encodeBase64(tweetnacl.sign.detached(
                new TextEncoder().encode(createCanonicalJsonSigningInput(payload)), decodeBase64(secret, 'base64url'),
            ), 'base64url') };
            const invalidClaim = { ...claim, payload: { ...payload,
                runnerBoxPublicKey: encodeBase64(tweetnacl.box.keyPair().publicKey, 'base64url'),
            } };
            await expect(exportRunnerActivationPackage({ ...input,
                projection: { ...input.projection, state: 'claimed', claim: invalidClaim },
            })).rejects.toThrow();
            expect(await readRunnerActivationSigningKey(custody.scope, custody.key)).toBe(secret);
            for (let retry = 0; retry < 2; retry += 1) {
                await expect(exportRunnerActivationPackage({ ...input,
                    projection: { ...input.projection, state: 'claimed', claim },
                })).rejects.toThrow('runner_activation_already_claimed');
            }
            expect(await readRunnerActivationSigningKey(custody.scope, custody.key)).toBe(secret);
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it('refuses export when the creating device has lost its protected key, even if raw activation bytes remain', async () => {
        const f = await fixture();
        const values = new Map<string, string>();
        vi.stubGlobal('window', { localStorage: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => { values.set(key, value); },
            removeItem: (key: string) => { values.delete(key); },
        } });
        vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({
            getFileHandle: async () => ({
                createWritable: async () => ({ write: async () => {}, close: async () => {} }),
                getFile: async () => new Blob(),
            }),
            removeEntry: async () => {},
        }) } });
        vi.stubGlobal('document', { body: { appendChild: () => {} }, createElement: () => ({ style: {}, click: () => {}, remove: () => {} }) });
        const scope = { serverId: 'home-a', accountId: 'creator' };
        try {
            const key = await createRunnerActivationKeyCustody(scope);
            const custody: RunnerActivationCustody = { scope, key, binding: {
                activationId: key.activationId,
                homeServerIdentityId: f.input.activationFile.home.homeServerIdentityId,
                creatorAccountId: scope.accountId,
                creatorTokenEpoch: 0,
                activationExpiresAt: null,
                workspace: { kind: 'choose_on_endpoint' },
                sessionId: 'session', machineId: 'machine',
                activationSigningPublicKey: key.activationSigningPublicKey,
                authoringCommitment: AUTHORING_COMMITMENT,
                artifact: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: f.input.activationFile.activation.artifact.sha256 },
                endpointFactsRecipient: { mode: 'plain', creatorAccountId: scope.accountId },
            } };
            await removeRunnerActivationKeyCustody(scope, key);
            const input = { ...f.input, custody, home: f.input.activationFile.home,
                projection: { ...custody.binding, draftId: 'draft-a', authoringCommitment: AUTHORING_COMMITMENT, state: 'pending', closeReason: null, claim: null, endpointFacts: null } };
            await expect(exportRunnerActivationPackage(input)).rejects.toMatchObject({ code: 'runner_activation_key_unavailable' });
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it.each(['ios', 'android'])('exports the real ZIP with %s recipient custody', async (os) => {
        const f = await fixture();
        platform.OS = os;
        sharing.observed.mockImplementation(async (uri: string, name?: string, mimeType?: string, UTI?: string) => {
            expect(fs.close).toHaveBeenCalledWith(uri);
            expect(mimeType).toBe('application/zip');
            if (os === 'ios') expect(UTI).toBe('public.zip-archive');
            const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(fs.files.get(uri)!)), { useWebWorkers: false });
            expect((await reader.getEntries()).map(entry => entry.filename)).toContain('happier-runner.activation.json');
            await reader.close();
        });
        try {
            await exportRunnerActivationPackage(await exportFixture(f));
            expect(sharing.observed).toHaveBeenCalledOnce();
            if (os === 'android') expect(sharing.observed.mock.calls[0][1]).toBe('temporary-computer-linux-x64.zip');
            expect(fs.files.size).toBe(os === 'android' ? 1 : 0);
            expect(sharing.observed.mock.calls[0][0]).toContain('/happier-downloads/');
        } finally {
            platform.OS = 'web';
            fs.files.clear();
            vi.clearAllMocks();
            sharing.observed.mockReset();
            vi.unstubAllGlobals();
            secureValues.clear();
        }
    });
    it.each(['ios', 'android'])('removes a rejected %s export handoff', async (os) => {
        platform.OS = os;
        sharing.failed = true;
        try {
            await expect(exportRunnerActivationPackage(await exportFixture(await fixture()))).rejects.toThrow('native_share_failed');
            expect(fs.files.size).toBe(0);
        } finally {
            platform.OS = 'web';
            sharing.failed = false;
            vi.clearAllMocks();
            sharing.observed.mockReset();
            vi.unstubAllGlobals();
            secureValues.clear();
        }
    });
    it('preserves unavailable export errors without leaving a native file', async () => {
        platform.OS = 'ios';
        sharing.available = false;
        try {
            await expect(exportRunnerActivationPackage(await exportFixture(await fixture()))).rejects.toThrow('runner_package_export_unavailable');
            expect(fs.files.size).toBe(0);
            expect(sharing.observed).not.toHaveBeenCalled();
        } finally {
            platform.OS = 'web';
            sharing.available = true;
            vi.clearAllMocks();
            sharing.observed.mockReset();
            vi.unstubAllGlobals();
            secureValues.clear();
        }
    });
    it('cleans a ZIP canceled while iOS sharing availability is resolving', async () => {
        platform.OS = 'ios';
        const controller = new AbortController();
        sharing.onAvailability = () => controller.abort();
        try {
            await expect(exportRunnerActivationPackage({ ...await exportFixture(await fixture()), signal: controller.signal })).rejects.toThrow('runner_package_canceled');
            expect(fs.files.size).toBe(0);
            expect(sharing.observed).not.toHaveBeenCalled();
        } finally {
            platform.OS = 'web';
            sharing.onAvailability = undefined;
            vi.clearAllMocks();
            sharing.observed.mockReset();
            vi.unstubAllGlobals();
            secureValues.clear();
        }
    });
    it('exports a completed private file through the browser and removes its temporary custody', async () => {
        const f = await fixture();
        const chunks: Uint8Array[] = [];
        let closed = false;
        let removed = false;
        let downloaded = false;
        vi.useFakeTimers();
        vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({
            getFileHandle: async () => ({
                createWritable: async () => ({ write: async (bytes: Uint8Array) => { chunks.push(bytes.slice()); }, close: async () => { closed = true; } }),
                getFile: async () => new Blob(chunks as BlobPart[]),
            }),
            removeEntry: async () => { removed = true; },
        }) } });
        vi.stubGlobal('document', { body: { appendChild: () => {} }, createElement: () => ({ style: {}, click: () => { expect(closed).toBe(true); downloaded = true; }, remove: () => {} }) });
        try {
            await exportRunnerActivationPackage(await exportFixture(f));
            expect(downloaded).toBe(true);
            const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(Buffer.concat(chunks))), { useWebWorkers: false });
            expect((await reader.getEntries()).map(entry => entry.filename)).toContain('happier-runner.activation.json');
            await reader.close();
            await vi.runAllTimersAsync();
            expect(removed).toBe(true);
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });
    it('verifies the actual ZIP and exports only immutable executable bytes plus the strict adjacent activation', async () => {
        const f = await fixture();
        await assembleRunnerActivationPackage(f.input);
        expect(f.closed()).toBe(true);
        const reader = new ZipReader(new Uint8ArrayReader(f.output()), { useWebWorkers: false });
        const entries = await reader.getEntries();
        expect(entries.map(e => e.filename)).toEqual(['happier-runner', 'happier-runner.activation.json']);
        const executable = entries[0];
        // Known small streams must remain readable by native ZIP extractors.
        expect(executable.zip64).not.toBe(true);
        expect(executable.externalFileAttributes >>> 16).toBe(0o100755);
        expect(!executable.directory && await executable.getData(new TextWriter())).toBe('immutable executable fixture');
        const activation = entries[1];
        expect(!activation.directory && JSON.parse(await activation.getData(new TextWriter()))).toEqual(f.input.activationFile);
        await reader.close();
    });

    it('rejects altered bytes, substituted identity and unknown activation fields before producing a package', async () => {
        for (const change of ['bytes', 'identity', 'schema', 'signature']) {
            const f = await fixture();
            if (change === 'bytes') f.input.source.bytes[50] ^= 1;
            if (change === 'identity') f.input.activationFile.activation.artifact.sha256 = '0'.repeat(64);
            if (change === 'schema') Object.assign(f.input.activationFile, { runtimeToken: 'never-export' });
            if (change === 'signature') f.input.checksumsText += 'tampering';
            await expect(assembleRunnerActivationPackage(f.input)).rejects.toThrow();
            expect(f.output().length).toBe(0);
            expect(f.closed()).toBe(false);
        }
    });

    it('rejects signed traversal, unexpected roots and nonregular executable entries', async () => {
        for (const entries of [
            [['../happier-runner', 'bad', 0o100755]],
            [['happier-runner', 'ok', 0o100755], ['extra', 'bad', 0o100644]],
            [['happier-runner', '/etc/passwd', 0o120777]],
        ] satisfies [string, string, number][][]) {
            const f = await fixture(entries);
            await expect(assembleRunnerActivationPackage(f.input)).rejects.toThrow();
            expect(f.output().length).toBe(0);
        }
    });

    it('rejects an archive whose authenticated closed entry set or expanded size disagrees with its ZIP census', async () => {
        const extra = await fixture(undefined, 'linux-x64', metadata => ({ ...metadata, entries: [
            ...metadata.entries,
            { path: 'extra', kind: 'file', sizeBytes: 1, mode: 0o644 },
        ] }));
        await expect(assembleRunnerActivationPackage(extra.input)).rejects.toThrow('runner_package_artifact_layout_mismatch');
        expect(extra.output().length).toBe(0);

        const wrongSize = await fixture(undefined, 'linux-x64', metadata => ({ ...metadata, entries: metadata.entries.map(entry => ({
            ...entry,
            sizeBytes: entry.sizeBytes + 1,
        })) }));
        await expect(assembleRunnerActivationPackage(wrongSize.input)).rejects.toThrow('runner_package_artifact_layout_mismatch');
        expect(wrongSize.output().length).toBe(0);
    });

    it('preserves a macOS bundle and internal relative link with explicit parent directories', async () => {
        const f = await fixture([
            ['Happier Runner.app/Contents/Info.plist', '<plist/>', 0o100644],
            ['Happier Runner.app/Contents/MacOS/happier-runner', 'immutable executable', 0o100755],
            ['Happier Runner.app/Contents/Resources/link', '../MacOS/happier-runner', 0o120777],
        ], 'darwin-arm64');
        await assembleRunnerActivationPackage(f.input);
        const reader = new ZipReader(new Uint8ArrayReader(f.output()), { useWebWorkers: false });
        const entries = await reader.getEntries();
        expect(entries.some(e => e.filename === 'Happier Runner.app/Contents/MacOS/' && e.directory)).toBe(true);
        const link = entries.find(e => e.filename.endsWith('/link'))!;
        expect(link.externalFileAttributes >>> 16).toBe(0o120777);
        expect(!link.directory && await link.getData(new TextWriter())).toBe('../MacOS/happier-runner');
        expect(entries.at(-1)?.filename).toBe('happier-runner.activation.json');
        await reader.close();
    });

    it('assembles the Windows portable directory with its core sidecar and the activation beside the shell', async () => {
        const windows = [
            ['Happier Runner/Happier Runner.exe', 'immutable executable', 0o100755],
            ['Happier Runner/happier-runner-core.exe', 'immutable core', 0o100755],
        ] satisfies [string, string, number][];
        const f = await fixture(windows, 'windows-x64');
        await assembleRunnerActivationPackage(f.input);
        const reader = new ZipReader(new Uint8ArrayReader(f.output()), { useWebWorkers: false });
        const entries = await reader.getEntries();
        // The shell resolves both its core sidecar and its activation file beside
        // the executable it launches, so all three stay inside the payload root.
        expect(entries.map(e => e.filename)).toEqual([
            'Happier Runner/',
            'Happier Runner/Happier Runner.exe',
            'Happier Runner/happier-runner-core.exe',
            'Happier Runner/happier-runner.activation.json',
        ]);
        const activation = entries.at(-1)!;
        expect(!activation.directory && JSON.parse(await activation.getData(new TextWriter()))).toEqual(f.input.activationFile);
        await reader.close();

        for (const entries of [
            [windows[0]],
            [windows[0], ['Happier Runner/renamed-core.exe', 'immutable core', 0o100755]],
            [...windows, ['Happier Runner/extra.dll', 'unreviewed', 0o100644]],
        ] satisfies [string, string, number][][]) {
            const rejected = await fixture(entries, 'windows-x64');
            await expect(assembleRunnerActivationPackage(rejected.input)).rejects.toThrow('runner_package_invalid_layout');
            expect(rejected.output().length).toBe(0);
        }
    });

    it('rejects a Darwin link that stays extraction-contained yet escapes the signed app payload root', async () => {
        const f = await fixture([
            ['Happier Runner.app/Contents/Info.plist', '<plist/>', 0o100644],
            ['Happier Runner.app/Contents/MacOS/happier-runner', 'immutable executable', 0o100755],
            ['Happier Runner.app/Contents/Resources/link', '../../..', 0o120777],
        ], 'darwin-arm64');
        await expect(assembleRunnerActivationPackage(f.input)).rejects.toThrow('runner_package_invalid_link');
        expect(f.output().length).toBe(0);
        expect(f.closed()).toBe(false);
    });

    it('accepts a chained in-payload framework graph including a contained dangling target', async () => {
        const f = await fixture([
            ['Happier Runner.app/Contents/Info.plist', '<plist/>', 0o100644],
            ['Happier Runner.app/Contents/MacOS/happier-runner', 'immutable executable', 0o100755],
            ['Happier Runner.app/Contents/Frameworks/Lib.framework/Versions/A/Lib', 'framework binary', 0o100644],
            ['Happier Runner.app/Contents/Frameworks/Lib.framework/Versions/Current', 'A', 0o120777],
            ['Happier Runner.app/Contents/Frameworks/Lib.framework/Lib', 'Versions/Current/Lib', 0o120777],
            ['Happier Runner.app/Contents/Frameworks/Lib.framework/Resources', 'Versions/Current/Missing', 0o120777],
        ], 'darwin-arm64');
        await assembleRunnerActivationPackage(f.input);
        expect(f.closed()).toBe(true);
        const reader = new ZipReader(new Uint8ArrayReader(f.output()), { useWebWorkers: false });
        const entries = await reader.getEntries();
        const dangling = entries.find(e => e.filename === 'Happier Runner.app/Contents/Frameworks/Lib.framework/Resources')!;
        expect(!dangling.directory && await dangling.getData(new TextWriter())).toBe('Versions/Current/Missing');
        const chained = entries.find(e => e.filename === 'Happier Runner.app/Contents/Frameworks/Lib.framework/Lib')!;
        expect(!chained.directory && await chained.getData(new TextWriter())).toBe('Versions/Current/Lib');
        await reader.close();
    });

    it('rejects a signed macOS symlink escape before writing anything', async () => {
        const f = await fixture([
            ['Happier Runner.app/Contents/Info.plist', '<plist/>', 0o100644],
            ['Happier Runner.app/Contents/MacOS/happier-runner', 'immutable executable', 0o100755],
            ['Happier Runner.app/Contents/Resources/link', '../../../outside', 0o120777],
        ], 'darwin-arm64');
        await expect(assembleRunnerActivationPackage(f.input)).rejects.toThrow();
        expect(f.output().length).toBe(0);
    });

    it('rejects chained symlink traversal that stays lexically in-bundle before stepwise resolution', async () => {
        const f = await fixture([
            ['Happier Runner.app/Contents/Info.plist', '<plist/>', 0o100644],
            ['Happier Runner.app/Contents/MacOS/happier-runner', 'immutable executable', 0o100755],
            ['Happier Runner.app/Contents/Resources/hop', '../..', 0o120777],
            ['Happier Runner.app/Contents/Resources/escape', 'hop/../../outside', 0o120777],
            ['Happier Runner.app/Contents/outside', 'lexical decoy', 0o100644],
        ], 'darwin-arm64');
        await expect(assembleRunnerActivationPackage(f.input)).rejects.toThrow('runner_package_invalid_link');
        expect(f.output().length).toBe(0);
        expect(f.closed()).toBe(false);
    });

    it('cleans partial sensitive output when the sink fails', async () => {
        const f = await fixture();
        f.input.destination.writeBytes = async () => { throw new Error('disk full'); };
        await expect(assembleRunnerActivationPackage(f.input)).rejects.toThrow('disk full');
        expect(f.cleaned()).toBe(true);
    });
});
