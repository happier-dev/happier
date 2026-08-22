import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_SERIALIZED_BYTES,
} from '@happier-dev/protocol';

const inventoryFilesystemBoundary = vi.hoisted(() => ({
    observe: false,
    recordReads: 0,
    syntheticDirectoryPath: null as string | null,
    syntheticDirectoryEntries: 0,
    directoryPulls: 0,
    directoryCloses: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
            if (
                inventoryFilesystemBoundary.observe
                && String(args[0]).replaceAll('\\', '/')
                    .includes('/external-sessions/hook-installations/v1')
                && String(args[0]).endsWith('.json')
            ) {
                inventoryFilesystemBoundary.recordReads += 1;
            }
            return await actual.open(...args);
        },
        opendir: async (...args: Parameters<typeof actual.opendir>) => {
            const normalizedPath = String(args[0]).replaceAll('\\', '/');
            if (
                inventoryFilesystemBoundary.syntheticDirectoryPath
                === normalizedPath
            ) {
                let index = 0;
                return {
                    async read() {
                        if (
                            index
                            >= inventoryFilesystemBoundary
                                .syntheticDirectoryEntries
                        ) {
                            return null;
                        }
                        const entryIndex = index;
                        index += 1;
                        inventoryFilesystemBoundary.directoryPulls += 1;
                        return {
                            name: `synthetic-${entryIndex}.json`,
                            isDirectory: () => false,
                            isFile: () => true,
                        };
                    },
                    async close() {
                        inventoryFilesystemBoundary.directoryCloses += 1;
                    },
                } as unknown as Awaited<ReturnType<typeof actual.opendir>>;
            }
            return await actual.opendir(...args);
        },
    };
});

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import {
    applyExternalSessionHookInstallationAction,
    readExternalSessionHookInstallationInventoryPage,
    readExternalSessionHookInstallationConfigSnapshot,
    readExternalSessionHookInstallationRecord,
    resolveExternalSessionHookInstallationRecordPath,
    type ExternalSessionHookInstallationVariant,
    type ExternalSessionHookJsonValue,
} from './hookInstallationConfiguration';

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'happier-external-hooks-config-'));
    const activeServerDir = join(root, 'server');
    const configDir = join(root, 'agent-config');
    await mkdir(activeServerDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    if (process.platform !== 'win32') await chmod(activeServerDir, 0o700);
    return { root, activeServerDir, configDir };
}

function variant(targetIds: readonly string[] = ['settings']): ExternalSessionHookInstallationVariant {
    return {
        variantId: 'fixture-lifecycle-v1',
        targets: targetIds.map((targetId) => ({
            targetId,
            format: 'hook_event_json_arrays_v1',
            collectionId: `hooks-${targetId}`,
        })),
        events: targetIds.flatMap((targetId) => ([
            {
                eventId: `start-${targetId}`,
                targetId,
                nativeEventName: 'SessionStart',
                command: {
                    kind: 'happier_observation_v1' as const,
                    shellDialect: 'posix' as const,
                },
            },
            {
                eventId: `stop-${targetId}`,
                targetId,
                nativeEventName: 'Stop',
                command: {
                    kind: 'happier_observation_v1' as const,
                    shellDialect: 'posix' as const,
                    matcher: 'final',
                    timeoutMs: 400,
                },
            },
        ])),
    };
}

function materializedEntry(input: Readonly<{
    event: ExternalSessionHookInstallationVariant['events'][number];
    installationIdentity: string;
}>): Readonly<Record<string, ExternalSessionHookJsonValue>> {
    return {
        matcher: input.event.command.matcher ?? null,
        hooks: [{
            type: 'command',
            command: `/private/forwarder --installation=${input.installationIdentity} --event=${input.event.eventId}`,
            timeout: Math.max(
                1,
                Math.ceil((input.event.command.timeoutMs ?? 500) / 1_000),
            ),
        }],
    };
}

function baseInput(input: Readonly<{
    activeServerDir: string;
    selectedVariant: ExternalSessionHookInstallationVariant;
    targets: readonly Readonly<{ targetId: string; absolutePath: string }>[];
}>) {
    return {
        activeServerDir: input.activeServerDir,
        machineId: 'machine-1',
        qualifiedAgent: { pluginId: 'happier.agent.fixture', localId: 'fixture' },
        hostInstallationId: 'install-1',
        installationIdentity: 'opaque-installation',
        executableIdentity: 'opaque-executable',
        ingressPrincipalRef: 'principal-ref',
        selectedVariant: input.selectedVariant,
        targets: input.targets,
        generation: { expected: 'generation-1', current: 'generation-1' },
        materializeOwnedEntry: materializedEntry,
        now: () => 1_000,
    };
}

function recordPath(input: ReturnType<typeof baseInput>): string {
    return resolveExternalSessionHookInstallationRecordPath({
        activeServerDir: input.activeServerDir,
        qualifiedAgent: input.qualifiedAgent,
        hostInstallationId: input.hostInstallationId,
    });
}

async function installInventoryRecord(input: Readonly<{
    activeServerDir: string;
    configDir: string;
    qualifiedAgent: Readonly<{ pluginId: string; localId: string }>;
    hostInstallationId: string;
}>): Promise<ReturnType<typeof baseInput>> {
    const targetPath = join(input.configDir, `${input.hostInstallationId}.json`);
    await writeFile(targetPath, '{"hooks":{}}');
    const actionInput = {
        ...baseInput({
            activeServerDir: input.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        }),
        qualifiedAgent: input.qualifiedAgent,
        hostInstallationId: input.hostInstallationId,
        installationIdentity: `installation-${input.hostInstallationId}`,
        executableIdentity: `executable-${input.hostInstallationId}`,
    };
    const result = await applyExternalSessionHookInstallationAction({
        ...actionInput,
        action: 'install',
    });
    expect(result).toMatchObject({ ok: true, state: 'installed_disabled' });
    return actionInput;
}

describe('External Sessions hook installation configuration', () => {
    it('reads ordered effect-free input identities and distinguishes missing, changed, and invalid config', async () => {
        const ctx = await fixture();
        const foundPath = join(ctx.configDir, 'found.json');
        const missingPath = join(ctx.configDir, 'missing.json');
        await writeFile(foundPath, '{"hooks":{"Foreign":[]}}');
        const selectedVariant = variant(['found', 'missing']);
        const targets = [
            { targetId: 'found', absolutePath: foundPath },
            { targetId: 'missing', absolutePath: missingPath },
        ];
        const first = await readExternalSessionHookInstallationConfigSnapshot({
            selectedVariant,
            targets,
        });
        expect(first).toMatchObject({
            ok: true,
            snapshot: {
                targets: [
                    {
                        targetId: 'found',
                        absolutePath: foundPath,
                        collectionId: 'hooks-found',
                        inputIdentity: expect.stringMatching(
                            /^input-v1:[0-9a-f]{64}$/u,
                        ),
                    },
                    {
                        targetId: 'missing',
                        absolutePath: missingPath,
                        collectionId: 'hooks-missing',
                        inputIdentity: expect.stringMatching(
                            /^input-missing-v1:[0-9a-f]{64}$/u,
                        ),
                    },
                ],
            },
        });

        await writeFile(foundPath, '{"hooks":{"Foreign":[{"x":1}]}}');
        const changed = await readExternalSessionHookInstallationConfigSnapshot({
            selectedVariant,
            targets,
        });
        expect(changed.ok && first.ok
            ? changed.snapshot.targets[0]!.inputIdentity
            : null).not.toBe(
            first.ok ? first.snapshot.targets[0]!.inputIdentity : null,
        );

        await writeFile(foundPath, '{not-json');
        await expect(readExternalSessionHookInstallationConfigSnapshot({
            selectedVariant,
            targets,
        })).resolves.toEqual({ ok: false, code: 'invalid_config' });
        await rm(ctx.root, { recursive: true, force: true });
    });

    it('rejects the removed selector/environment model and requires concrete plugin-resolved targets', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'settings.json');
        const original = '{"hooks":{}}';
        await writeFile(targetPath, original);
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });

        const result = await applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
            targets: undefined,
            rootResolution: {
                environment: { CLAUDE_CONFIG_DIR: f.configDir },
            },
        } as unknown as Parameters<typeof applyExternalSessionHookInstallationAction>[0]);

        expect(result).toEqual({ ok: false, code: 'invalid_target_path' });
        expect(await readFile(targetPath, 'utf8')).toBe(original);
    });

    it('installs every selected-variant event and plugin-unavailable uninstall preserves identical foreign entries', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'settings.json');
        const selectedVariant = variant();
        const desiredStop = materializedEntry({
            event: selectedVariant.events[1]!,
            installationIdentity: 'opaque-installation',
        });
        expect(desiredStop).toMatchObject({
            hooks: [{ timeout: 1 }],
        });
        const foreignOther = { matcher: 'foreign', hooks: [{ command: 'foreign' }] };
        await writeFile(targetPath, JSON.stringify({
            untouched: { keep: true },
            hooks: {
                Stop: [desiredStop, foreignOther],
            },
        }, null, 2));
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant,
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });

        await expect(applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
        })).resolves.toMatchObject({
            ok: true,
            state: 'installed_disabled',
            changedConfiguration: true,
        });
        const installed = JSON.parse(await readFile(targetPath, 'utf8')) as {
            hooks: Record<string, unknown[]>;
        };
        expect(installed.hooks.SessionStart).toHaveLength(1);
        expect(installed.hooks.Stop).toEqual([desiredStop, foreignOther, desiredStop]);

        const record = await readExternalSessionHookInstallationRecord(recordPath(input));
        expect(record).toMatchObject({
            state: 'disabled',
            variantId: 'fixture-lifecycle-v1',
            ownedEntries: [
                {
                    eventId: 'start-settings',
                    occurrenceCount: 1,
                    entryIndex: 0,
                    identicalEntriesBefore: 0,
                },
                {
                    eventId: 'stop-settings',
                    occurrenceCount: 1,
                    entryIndex: 2,
                    identicalEntriesBefore: 1,
                },
            ],
        });

        const observedUninstallStates: string[] = [];
        await expect(applyExternalSessionHookInstallationAction({
            action: 'uninstall',
            activeServerDir: input.activeServerDir,
            machineId: input.machineId,
            qualifiedAgent: input.qualifiedAgent,
            hostInstallationId: input.hostInstallationId,
            installationIdentity: input.installationIdentity,
            executableIdentity: input.executableIdentity,
            ingressPrincipalRef: input.ingressPrincipalRef,
            now: input.now,
            persistence: {
                writeConfigurationAtomic: async (path, value) => {
                    observedUninstallStates.push(
                        (await readExternalSessionHookInstallationRecord(recordPath(input)))?.state
                            ?? 'missing',
                    );
                    await writeJsonAtomic(path, value);
                },
            },
        })).resolves.toMatchObject({
            ok: true,
            state: 'not_installed',
            changedConfiguration: true,
        });
        expect(observedUninstallStates).toEqual(['revoked']);
        const uninstalled = JSON.parse(await readFile(targetPath, 'utf8')) as {
            hooks: Record<string, unknown[]>;
            untouched: unknown;
        };
        expect(uninstalled.hooks.SessionStart).toEqual([]);
        expect(uninstalled.hooks.Stop).toEqual([desiredStop, foreignOther]);
        expect(uninstalled.untouched).toEqual({ keep: true });
    });

    it('persists preparing before config replacement and retains it when final record publication fails', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'settings.json');
        await writeFile(targetPath, '{"hooks":{}}');
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });
        let recordWrites = 0;
        const observedStates: string[] = [];

        const result = await applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
            persistence: {
                writeInstallationRecordAtomic: async (path, value) => {
                    recordWrites += 1;
                    if (recordWrites === 2) throw new Error('final record write failed');
                    await writeJsonAtomic(path, value);
                },
                writeConfigurationAtomic: async (path, value) => {
                    observedStates.push(
                        (await readExternalSessionHookInstallationRecord(recordPath(input)))?.state ?? 'missing',
                    );
                    await writeJsonAtomic(path, value);
                },
            },
        });

        expect(result).toEqual({ ok: false, code: 'write_failed' });
        expect(observedStates).toEqual(['preparing']);
        expect(await readExternalSessionHookInstallationRecord(recordPath(input))).toMatchObject({
            state: 'preparing',
            variantId: 'fixture-lifecycle-v1',
        });
        expect(JSON.parse(await readFile(targetPath, 'utf8'))).toMatchObject({
            hooks: { SessionStart: [expect.any(Object)], Stop: [expect.any(Object)] },
        });
    });

    it('does not mutate config when preparing record publication fails', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'settings.json');
        const original = '{"hooks":{}}';
        await writeFile(targetPath, original);
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });
        const writeConfigurationAtomic = vi.fn();

        await expect(applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
            persistence: {
                writeInstallationRecordAtomic: async () => {
                    throw new Error('preparing failed');
                },
                writeConfigurationAtomic,
            },
        })).resolves.toEqual({ ok: false, code: 'write_failed' });
        expect(writeConfigurationAtomic).not.toHaveBeenCalled();
        expect(await readFile(targetPath, 'utf8')).toBe(original);
    });

    it('rejects invalid JSON before publishing a preparing record', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'settings.json');
        const invalid = '{"hooks":';
        await writeFile(targetPath, invalid);
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });

        await expect(applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
        })).resolves.toEqual({ ok: false, code: 'invalid_config' });
        expect(await readFile(targetPath, 'utf8')).toBe(invalid);
        expect(await readExternalSessionHookInstallationRecord(recordPath(input))).toBeNull();
    });

    it('rejects malformed UTF-8 without rewriting foreign configuration or publishing custody', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'settings.json');
        const malformed = Buffer.concat([
            Buffer.from('{"foreign":"', 'utf8'),
            Buffer.from([0xc3, 0x28]),
            Buffer.from('","hooks":{}}', 'utf8'),
        ]);
        await writeFile(targetPath, malformed);
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });

        await expect(applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
        })).resolves.toEqual({ ok: false, code: 'invalid_config' });
        expect(await readFile(targetPath)).toEqual(malformed);
        expect(await readExternalSessionHookInstallationRecord(recordPath(input))).toBeNull();
    });

    it('installs with compare-and-swap semantics when the target does not exist yet', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'missing-settings.json');
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });

        await expect(applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
        })).resolves.toMatchObject({
            ok: true,
            state: 'installed_disabled',
            changedConfiguration: true,
        });
        expect(JSON.parse(await readFile(targetPath, 'utf8'))).toMatchObject({
            hooks: {
                SessionStart: [expect.any(Object)],
                Stop: [expect.any(Object)],
            },
        });
    });

    it('rejects install when confirmed preview input identities are no longer current', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'preview-changed-before-install.json');
        await writeFile(targetPath, '{"hooks":{}}');
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });
        const snapshot = await readExternalSessionHookInstallationConfigSnapshot({
            selectedVariant: input.selectedVariant,
            targets: input.targets,
        });
        if (!snapshot.ok) throw new Error('expected valid config snapshot');
        const newer = '{"hooks":{"Foreign":[{"newer":true}]}}';
        await writeFile(targetPath, newer);

        await expect(applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
            expectedInputIdentities: snapshot.snapshot.targets.map((target) => ({
                targetId: target.targetId,
                inputIdentity: target.inputIdentity,
            })),
        })).resolves.toEqual({ ok: false, code: 'concurrent_edit' });
        expect(await readFile(targetPath, 'utf8')).toBe(newer);
        expect(await readExternalSessionHookInstallationRecord(recordPath(input))).toBeNull();
    });

    it('accepts the exact Agent-config byte ceiling and rejects max plus one before mutation', async () => {
        const f = await fixture();
        const exactPath = join(f.configDir, 'exact-config-limit.json');
        const oversizedPath = join(f.configDir, 'oversized-config-limit.json');
        const minimal = '{"hooks":{}}';
        const exactBytes = Buffer.from(
            `${minimal}${' '.repeat(
                PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_SERIALIZED_BYTES
                    - Buffer.byteLength(minimal),
            )}`,
        );
        const oversizedBytes = Buffer.concat([exactBytes, Buffer.from(' ')]);
        await writeFile(oversizedPath, oversizedBytes);
        let exactCurrentBytes = exactBytes;

        const exactInput = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: exactPath }],
        });
        await expect(applyExternalSessionHookInstallationAction({
            ...exactInput,
            action: 'install',
            persistence: {
                readConfiguration: async () => exactCurrentBytes,
                readConfigurationForVerification: async () => exactCurrentBytes,
                writeConfigurationAtomic: async (_path, value) => {
                    exactCurrentBytes = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
                },
            },
        })).resolves.toMatchObject({ ok: true, state: 'installed_disabled' });
        expect(JSON.parse(exactCurrentBytes.toString('utf8'))).toMatchObject({
            hooks: {
                SessionStart: [expect.any(Object)],
                Stop: [expect.any(Object)],
            },
        });

        const oversizedInput = {
            ...baseInput({
                activeServerDir: f.activeServerDir,
                selectedVariant: variant(),
                targets: [{ targetId: 'settings', absolutePath: oversizedPath }],
            }),
            hostInstallationId: 'install-oversized-config',
            installationIdentity: 'installation-oversized-config',
        };
        await expect(applyExternalSessionHookInstallationAction({
            ...oversizedInput,
            action: 'install',
        })).resolves.toEqual({ ok: false, code: 'invalid_config' });
        expect((await readFile(oversizedPath)).equals(oversizedBytes)).toBe(true);
        expect(await readExternalSessionHookInstallationRecord(recordPath(oversizedInput)))
            .toBeNull();
    });

    it('does not overwrite a target changed after preview and before replacement', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'settings.json');
        await writeFile(targetPath, '{"hooks":{}}');
        const newer = '{"hooks":{"Stop":[{"external-newer":true}]}}';
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });

        const result = await applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
            testHooks: {
                beforeCompareAndSwap: async () => {
                    await writeFile(targetPath, newer);
                },
            },
        });

        expect(result).toEqual({ ok: false, code: 'concurrent_edit' });
        expect(await readFile(targetPath, 'utf8')).toBe(newer);
        expect(await readExternalSessionHookInstallationRecord(recordPath(input))).toMatchObject({
            state: 'preparing',
        });
    });

    it('does not publish preparing or config bytes when install is already retired', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'retired-before-install.json');
        const original = '{"hooks":{}}';
        await writeFile(targetPath, original);
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });

        await expect(applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
            isCurrent: async () => false,
        })).resolves.toEqual({ ok: false, code: 'generation_mismatch' });
        expect(await readFile(targetPath, 'utf8')).toBe(original);
        expect(await readExternalSessionHookInstallationRecord(recordPath(input))).toBeNull();
    });

    it('leaves truthful preparing custody and no config write when install retires after admission', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'retired-after-preparing.json');
        const original = '{"hooks":{}}';
        await writeFile(targetPath, original);
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });
        let currentChecks = 0;

        await expect(applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
            isCurrent: async () => {
                currentChecks += 1;
                return currentChecks === 1;
            },
        })).resolves.toEqual({ ok: false, code: 'reconciliation_required' });
        expect(await readFile(targetPath, 'utf8')).toBe(original);
        expect(await readExternalSessionHookInstallationRecord(recordPath(input))).toMatchObject({
            state: 'preparing',
        });
    });

    it('rolls back exact config bytes and never publishes active after retirement at final publication', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'retired-before-active.json');
        const original = '{\n "marker" : "exact",\n "hooks" : {}\n}\n';
        await writeFile(targetPath, original);
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });
        let currentChecks = 0;

        await expect(applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
            isCurrent: () => {
                currentChecks += 1;
                return currentChecks < 3;
            },
        })).resolves.toEqual({ ok: false, code: 'reconciliation_required' });
        expect(await readFile(targetPath, 'utf8')).toBe(original);
        expect(await readExternalSessionHookInstallationRecord(recordPath(input))).toMatchObject({
            state: 'preparing',
        });
    });

    it('compensates an active publication when currentness flips during its record write', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'retired-during-active-write.json');
        const original = '{\n "marker" : "during-write",\n "hooks" : {}\n}\n';
        await writeFile(targetPath, original);
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });
        let currentChecks = 0;

        await expect(applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
            isCurrent: () => {
                currentChecks += 1;
                return currentChecks < 4;
            },
        })).resolves.toEqual({ ok: false, code: 'reconciliation_required' });
        expect(await readFile(targetPath, 'utf8')).toBe(original);
        expect(await readExternalSessionHookInstallationRecord(recordPath(input))).toMatchObject({
            state: 'preparing',
        });
    });

    it('requires reconciliation instead of stranding entries when a reinstall target moves', async () => {
        const f = await fixture();
        const originalPath = join(f.configDir, 'settings.json');
        const movedPath = join(f.configDir, 'settings-moved.json');
        await writeFile(originalPath, '{"hooks":{}}');
        await writeFile(movedPath, '{"hooks":{}}');
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: originalPath }],
        });
        await applyExternalSessionHookInstallationAction({ ...input, action: 'install' });
        const originalBefore = await readFile(originalPath);
        const movedBefore = await readFile(movedPath);

        await expect(applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
            targets: [{ targetId: 'settings', absolutePath: movedPath }],
        })).resolves.toEqual({ ok: false, code: 'reconciliation_required' });
        expect(await readFile(originalPath)).toEqual(originalBefore);
        expect(await readFile(movedPath)).toEqual(movedBefore);
    });

    it('reports reconciliation and preserves newer bytes after a multi-target partial failure', async () => {
        const f = await fixture();
        const firstPath = join(f.configDir, 'first.json');
        const secondPath = join(f.configDir, 'second.json');
        await writeFile(firstPath, '{"hooks":{}}');
        await writeFile(secondPath, '{"hooks":{}}');
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(['first', 'second']),
            targets: [
                { targetId: 'first', absolutePath: firstPath },
                { targetId: 'second', absolutePath: secondPath },
            ],
        });
        const newer = '{"hooks":{"Stop":[{"external-newer":true}]}}';
        let writes = 0;

        const result = await applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
            persistence: {
                writeConfigurationAtomic: async (path, value) => {
                    writes += 1;
                    if (writes === 2) {
                        await writeFile(firstPath, newer);
                        throw new Error('second target failed');
                    }
                    await writeJsonAtomic(path, value);
                },
            },
        });

        expect(result).toEqual({ ok: false, code: 'reconciliation_required' });
        expect(await readFile(firstPath, 'utf8')).toBe(newer);
        expect(await readFile(secondPath, 'utf8')).toBe('{"hooks":{}}');
        expect(await readExternalSessionHookInstallationRecord(recordPath(input))).toMatchObject({
            state: 'preparing',
        });
    });

    it('restores exact original bytes after a clean multi-target partial failure', async () => {
        const f = await fixture();
        const firstPath = join(f.configDir, 'first-exact.json');
        const secondPath = join(f.configDir, 'second-exact.json');
        const firstOriginal = '{\n  "marker" : "first",\n  "hooks" : { }\n}\n';
        const secondOriginal = '{"marker":"second","hooks":{}}\n';
        await writeFile(firstPath, firstOriginal);
        await writeFile(secondPath, secondOriginal);
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(['first', 'second']),
            targets: [
                { targetId: 'first', absolutePath: firstPath },
                { targetId: 'second', absolutePath: secondPath },
            ],
        });
        let candidateWrites = 0;

        const result = await applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
            persistence: {
                writeConfigurationAtomic: async (path, value) => {
                    candidateWrites += 1;
                    if (candidateWrites === 2) throw new Error('second target failed');
                    await writeJsonAtomic(path, value);
                },
            },
        });

        expect(result).toEqual({ ok: false, code: 'write_failed' });
        expect(await readFile(firstPath, 'utf8')).toBe(firstOriginal);
        expect(await readFile(secondPath, 'utf8')).toBe(secondOriginal);
    });

    it('reading a preparing record after restart is passive', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'settings.json');
        await writeFile(targetPath, '{"hooks":{}}');
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });
        let recordWrites = 0;
        await applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
            persistence: {
                writeInstallationRecordAtomic: async (path, value) => {
                    recordWrites += 1;
                    if (recordWrites === 2) throw new Error('simulated crash boundary');
                    await writeJsonAtomic(path, value);
                },
            },
        });
        const before = await readFile(targetPath);

        expect(await readExternalSessionHookInstallationRecord(recordPath(input))).toMatchObject({
            state: 'preparing',
        });
        expect(await readFile(targetPath)).toEqual(before);
    });

    it('fails closed when the durable record is unreadable instead of reporting not installed', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'settings.json');
        const original = '{"hooks":{"Stop":[{"possibly-owned":true}]}}';
        await writeFile(targetPath, original);
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });
        const path = recordPath(input);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, '{"schemaVersion":1');

        await expect(applyExternalSessionHookInstallationAction({
            action: 'uninstall',
            activeServerDir: input.activeServerDir,
            machineId: input.machineId,
            qualifiedAgent: input.qualifiedAgent,
            hostInstallationId: input.hostInstallationId,
            installationIdentity: input.installationIdentity,
            executableIdentity: input.executableIdentity,
            ingressPrincipalRef: input.ingressPrincipalRef,
        })).resolves.toEqual({ ok: false, code: 'reconciliation_required' });
        expect(await readFile(targetPath, 'utf8')).toBe(original);
    });

    it('rejects malformed UTF-8 custody without losing the record or its real owned entries', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'utf8-custody-target.json');
        await writeFile(targetPath, '{"hooks":{}}');
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });
        await applyExternalSessionHookInstallationAction({ ...input, action: 'install' });
        const installedConfiguration = await readFile(targetPath);
        const path = recordPath(input);
        const validRecord = await readFile(path);
        const encodedTargetPath = JSON.stringify(targetPath).slice(1, -1);
        const encodedTargetPathBytes = Buffer.from(encodedTargetPath, 'utf8');
        const targetPathOffset = validRecord.indexOf(encodedTargetPathBytes);
        expect(targetPathOffset).toBeGreaterThanOrEqual(0);
        const invalidRecord = Buffer.from(validRecord);
        invalidRecord[targetPathOffset + encodedTargetPathBytes.byteLength - 1] = 0xff;
        await writeFile(path, invalidRecord);

        await expect(readExternalSessionHookInstallationInventoryPage({
            activeServerDir: f.activeServerDir,
            qualifiedAgent: input.qualifiedAgent,
        })).resolves.toMatchObject({
            ok: true,
            records: [],
            diagnostics: [{
                code: 'invalid_record',
                recordRef: expect.stringMatching(/^[a-f0-9]{64}$/u),
            }],
        });
        await expect(applyExternalSessionHookInstallationAction({
            action: 'uninstall',
            activeServerDir: input.activeServerDir,
            machineId: input.machineId,
            qualifiedAgent: input.qualifiedAgent,
            hostInstallationId: input.hostInstallationId,
            installationIdentity: input.installationIdentity,
            executableIdentity: input.executableIdentity,
            ingressPrincipalRef: input.ingressPrincipalRef,
        })).resolves.toEqual({ ok: false, code: 'reconciliation_required' });
        expect(await readFile(path)).toEqual(invalidRecord);
        expect(await readFile(targetPath)).toEqual(installedConfiguration);
    });

    it('rejects a durable record whose cleanup target path is no longer valid', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'settings.json');
        await writeFile(targetPath, '{"hooks":{}}');
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });
        await applyExternalSessionHookInstallationAction({ ...input, action: 'install' });
        const installed = await readFile(targetPath);
        const path = recordPath(input);
        const tampered = JSON.parse(await readFile(path, 'utf8')) as {
            targets: Array<{ absolutePath: string }>;
        };
        tampered.targets[0]!.absolutePath = 'relative-target.json';
        await writeJsonAtomic(path, tampered);

        await expect(applyExternalSessionHookInstallationAction({
            action: 'uninstall',
            activeServerDir: input.activeServerDir,
            machineId: input.machineId,
            qualifiedAgent: input.qualifiedAgent,
            hostInstallationId: input.hostInstallationId,
            installationIdentity: input.installationIdentity,
            executableIdentity: input.executableIdentity,
            ingressPrincipalRef: input.ingressPrincipalRef,
        })).resolves.toEqual({ ok: false, code: 'reconciliation_required' });
        expect(await readFile(targetPath)).toEqual(installed);
    });

    it('disable and enable update only the installation record', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'settings.json');
        await writeFile(targetPath, '{"hooks":{}}');
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });
        await applyExternalSessionHookInstallationAction({ ...input, action: 'install' });
        const before = await readFile(targetPath);
        const writeConfigurationAtomic = vi.fn(async () => {
            throw new Error('configuration write must not run');
        });

        await expect(applyExternalSessionHookInstallationAction({
            ...input,
            action: 'disable',
            persistence: { writeConfigurationAtomic },
        })).resolves.toMatchObject({ ok: true, state: 'installed_disabled', changedConfiguration: false });
        await expect(applyExternalSessionHookInstallationAction({
            ...input,
            action: 'enable',
            persistence: { writeConfigurationAtomic },
        })).resolves.toMatchObject({ ok: true, state: 'installed_enabled', changedConfiguration: false });
        expect(writeConfigurationAtomic).not.toHaveBeenCalled();
        expect(await readFile(targetPath)).toEqual(before);
    });

    it('does not publish a late enabled record after currentness is lost', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'retired-enable.json');
        await writeFile(targetPath, '{"hooks":{}}');
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });
        await applyExternalSessionHookInstallationAction({ ...input, action: 'install' });
        await applyExternalSessionHookInstallationAction({ ...input, action: 'disable' });

        await expect(applyExternalSessionHookInstallationAction({
            ...input,
            action: 'enable',
            isCurrent: () => false,
        })).resolves.toEqual({ ok: false, code: 'generation_mismatch' });
        expect(await readExternalSessionHookInstallationRecord(recordPath(input))).toMatchObject({
            state: 'disabled',
        });
    });

    it('uninstalls cleanly when the owned target was already deleted', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'deleted-before-uninstall.json');
        await writeFile(targetPath, '{"hooks":{}}');
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });
        await applyExternalSessionHookInstallationAction({ ...input, action: 'install' });
        await rm(targetPath);

        await expect(applyExternalSessionHookInstallationAction({
            action: 'uninstall',
            activeServerDir: input.activeServerDir,
            machineId: input.machineId,
            qualifiedAgent: input.qualifiedAgent,
            hostInstallationId: input.hostInstallationId,
            installationIdentity: input.installationIdentity,
            executableIdentity: input.executableIdentity,
            ingressPrincipalRef: input.ingressPrincipalRef,
        })).resolves.toMatchObject({
            ok: true,
            state: 'not_installed',
            changedConfiguration: false,
        });
        await expect(readFile(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readExternalSessionHookInstallationRecord(recordPath(input))).toBeNull();
        await expect(lstat(dirname(recordPath(input)))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('uninstalls only the custodied occurrence when an identical foreign entry was appended later', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'copied-owned-entry.json');
        await writeFile(targetPath, '{"hooks":{}}');
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });
        await applyExternalSessionHookInstallationAction({ ...input, action: 'install' });
        const installed = JSON.parse(await readFile(targetPath, 'utf8')) as {
            hooks: Record<string, unknown[]>;
        };
        const appendedForeignEntry = structuredClone(installed.hooks.Stop![0]);
        installed.hooks.Stop!.push(appendedForeignEntry);
        await writeFile(targetPath, JSON.stringify(installed, null, 2));

        await expect(applyExternalSessionHookInstallationAction({
            action: 'uninstall',
            activeServerDir: input.activeServerDir,
            machineId: input.machineId,
            qualifiedAgent: input.qualifiedAgent,
            hostInstallationId: input.hostInstallationId,
            installationIdentity: input.installationIdentity,
            executableIdentity: input.executableIdentity,
            ingressPrincipalRef: input.ingressPrincipalRef,
        })).resolves.toMatchObject({
            ok: true,
            state: 'not_installed',
            changedConfiguration: true,
        });
        const uninstalled = JSON.parse(await readFile(targetPath, 'utf8')) as {
            hooks: Record<string, unknown[]>;
        };
        expect(uninstalled.hooks.SessionStart).toEqual([]);
        expect(uninstalled.hooks.Stop).toEqual([appendedForeignEntry]);
        expect(await readExternalSessionHookInstallationRecord(recordPath(input))).toBeNull();
    });

    it('keeps the installation record private and stores only cleanup-required local facts', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'settings.json');
        const foreignSecret = 'foreign-secret-value';
        await writeFile(targetPath, JSON.stringify({
            hooks: { Stop: [{ command: foreignSecret }] },
        }));
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });
        await applyExternalSessionHookInstallationAction({ ...input, action: 'install' });

        const path = recordPath(input);
        const raw = await readFile(path, 'utf8');
        expect(raw).not.toContain(foreignSecret);
        expect(raw).not.toContain('nativePayload');
        expect(raw).not.toContain('sessionId');
        expect(await readExternalSessionHookInstallationRecord(path)).toMatchObject({
            schemaVersion: 1,
            machineId: 'machine-1',
            variantId: 'fixture-lifecycle-v1',
            targets: [{ absolutePath: targetPath }],
            state: 'disabled',
            revision: 1,
        });
        if (process.platform !== 'win32') {
            expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
            expect((await lstat(path)).mode & 0o777).toBe(0o600);
        }
    });

    it('accepts the full nonnegative safe-integer entry index range in durable custody', async () => {
        const f = await fixture();
        const targetPath = join(f.configDir, 'settings.json');
        await writeFile(targetPath, JSON.stringify({ hooks: {} }));
        const input = baseInput({
            activeServerDir: f.activeServerDir,
            selectedVariant: variant(),
            targets: [{ targetId: 'settings', absolutePath: targetPath }],
        });
        await applyExternalSessionHookInstallationAction({
            ...input,
            action: 'install',
        });

        const path = recordPath(input);
        const record = JSON.parse(await readFile(path, 'utf8')) as {
            ownedEntries: Array<Record<string, unknown>>;
        };
        record.ownedEntries[0]!.entryIndex = Number.MAX_SAFE_INTEGER;
        await writeFile(path, JSON.stringify(record));

        const reloaded =
            await readExternalSessionHookInstallationRecord(path);
        expect(reloaded?.ownedEntries[0]?.entryIndex)
            .toBe(Number.MAX_SAFE_INTEGER);
    });

    it('reads a deterministic sanitized page while preserving multiple installations per Agent', async () => {
        const f = await fixture();
        const qualifiedAgent = {
            pluginId: 'happier.agent.inventory',
            localId: 'inventory',
        };
        const installations = await Promise.all([
            installInventoryRecord({
                activeServerDir: f.activeServerDir,
                configDir: f.configDir,
                qualifiedAgent,
                hostInstallationId: 'install-z',
            }),
            installInventoryRecord({
                activeServerDir: f.activeServerDir,
                configDir: f.configDir,
                qualifiedAgent,
                hostInstallationId: 'install-a',
            }),
            installInventoryRecord({
                activeServerDir: f.activeServerDir,
                configDir: f.configDir,
                qualifiedAgent,
                hostInstallationId: 'install-m',
            }),
        ]);
        const before = await Promise.all(installations.map(async (input) => ({
            configuration: await readFile(input.targets[0]!.absolutePath),
            record: await readFile(recordPath(input)),
        })));

        const first = await readExternalSessionHookInstallationInventoryPage({
            activeServerDir: f.activeServerDir,
            qualifiedAgent,
            limit: 2,
        });
        expect(first).toMatchObject({
            ok: true,
            records: [expect.any(Object), expect.any(Object)],
            diagnostics: [],
            nextCursor: expect.any(String),
        });
        if (!first.ok || !first.nextCursor) throw new Error('expected first inventory page');
        const repeated = await readExternalSessionHookInstallationInventoryPage({
            activeServerDir: f.activeServerDir,
            qualifiedAgent,
            limit: 2,
        });
        expect(repeated).toEqual(first);
        const second = await readExternalSessionHookInstallationInventoryPage({
            activeServerDir: f.activeServerDir,
            qualifiedAgent,
            limit: 2,
            cursor: first.nextCursor,
        });
        expect(second).toMatchObject({ ok: true, diagnostics: [] });
        if (!second.ok) throw new Error('expected second inventory page');
        expect(second.nextCursor).toBeUndefined();
        expect([...first.records, ...second.records].map((record) => record.installationId).sort())
            .toEqual(['install-a', 'install-m', 'install-z']);
        expect(Object.keys(first.records[0]!).sort()).toEqual([
            'installationId',
            'machineId',
            'qualifiedAgent',
            'revision',
            'state',
            'updatedAtMs',
            'variantId',
        ]);
        const serialized = JSON.stringify([first, second]);
        expect(serialized).not.toContain(f.configDir);
        expect(serialized).not.toContain('/private/forwarder');
        expect(serialized).not.toContain('principal-ref');
        expect(serialized).not.toContain('opaque-executable');
        const decodedCursor = Buffer.from(first.nextCursor, 'base64url').toString('utf8');
        expect(decodedCursor).not.toContain(f.activeServerDir);
        expect(decodedCursor).not.toContain(qualifiedAgent.pluginId);
        expect(decodedCursor).not.toContain('install-');

        const after = await Promise.all(installations.map(async (input) => ({
            configuration: await readFile(input.targets[0]!.absolutePath),
            record: await readFile(recordPath(input)),
        })));
        expect(after).toEqual(before);
    });

    it('rejects oversized files before admitting an otherwise valid record', async () => {
        const f = await fixture();
        const qualifiedAgent = {
            pluginId: 'happier.agent.oversized-file',
            localId: 'oversized-file',
        };
        const installed = await installInventoryRecord({
            activeServerDir: f.activeServerDir,
            configDir: f.configDir,
            qualifiedAgent,
            hostInstallationId: 'oversized-file-1',
        });
        const path = recordPath(installed);
        const validRecord = await readFile(path, 'utf8');
        await writeFile(
            path,
            `${validRecord}${' '.repeat(
                PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_SERIALIZED_BYTES,
            )}`,
        );

        const result = await readExternalSessionHookInstallationInventoryPage({
            activeServerDir: f.activeServerDir,
            qualifiedAgent,
        });

        expect(result).toMatchObject({
            ok: true,
            records: [],
            diagnostics: [{
                code: 'invalid_record',
                recordRef: expect.stringMatching(/^[a-f0-9]{64}$/u),
            }],
        });
    });

    it('rejects records that exceed bounded string, array, or entry JSON ceilings', async () => {
        const f = await fixture();
        const qualifiedAgent = {
            pluginId: 'happier.agent.oversized-record',
            localId: 'oversized-record',
        };
        const installed = await installInventoryRecord({
            activeServerDir: f.activeServerDir,
            configDir: f.configDir,
            qualifiedAgent,
            hostInstallationId: 'oversized-record-1',
        });
        const path = recordPath(installed);
        const baseline = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        const baselineOwnedEntry =
            (baseline.ownedEntries as Record<string, unknown>[])[0]!;
        const cases: readonly Record<string, unknown>[] = [
            {
                ...baseline,
                machineId: 'm'.repeat(513),
            },
            {
                ...baseline,
                targets: [
                    ...(baseline.targets as Record<string, unknown>[]),
                    ...Array.from({ length: 4 }, (_, index) => ({
                        targetId: `target-${index}`,
                        absolutePath: join(f.configDir, `bounded-${index}.json`),
                        collectionId: `collection-${index}`,
                        inputIdentity: `input-v1:${String(index).padStart(64, '0')}`,
                    })),
                ],
            },
            {
                ...baseline,
                ownedEntries: Array.from({ length: 65 }, (_, index) => ({
                    ...baselineOwnedEntry,
                    eventId: `event-${index}`,
                    nativeEventName: `Event${index}`,
                    entryIdentity: `entry-v1:${String(index).padStart(64, '0')}`,
                    entry: { command: `command-${index}` },
                    entryIndex: index,
                    identicalEntriesBefore: 0,
                })),
            },
            {
                ...baseline,
                ownedEntries: [{
                    ...baselineOwnedEntry,
                    entry: { value: 'x'.repeat((64 * 1024) + 1) },
                }],
            },
        ];

        for (const value of cases) {
            await writeFile(path, JSON.stringify(value));
            const result = await readExternalSessionHookInstallationInventoryPage({
                activeServerDir: f.activeServerDir,
                qualifiedAgent,
            });
            expect(result).toMatchObject({
                ok: true,
                records: [],
                diagnostics: [{ code: 'invalid_record' }],
            });
        }
    });

    it('walks a large inventory deterministically across bounded pages', async () => {
        const f = await fixture();
        const qualifiedAgent = {
            pluginId: 'happier.agent.large-inventory',
            localId: 'large-inventory',
        };
        const firstInstallation = await installInventoryRecord({
            activeServerDir: f.activeServerDir,
            configDir: f.configDir,
            qualifiedAgent,
            hostInstallationId: 'bulk-000',
        });
        const baseline = JSON.parse(
            await readFile(recordPath(firstInstallation), 'utf8'),
        ) as Record<string, unknown>;
        const expectedIds = Array.from(
            { length: 120 },
            (_, index) => `bulk-${String(index).padStart(3, '0')}`,
        );
        for (const installationId of expectedIds.slice(1)) {
            const path = resolveExternalSessionHookInstallationRecordPath({
                activeServerDir: f.activeServerDir,
                qualifiedAgent,
                hostInstallationId: installationId,
            });
            await writeFile(path, JSON.stringify({
                ...baseline,
                hostInstallationId: installationId,
                installationIdentity: `installation-${installationId}`,
                executableIdentity: `executable-${installationId}`,
            }));
        }

        const walk = async () => {
            const observedIds: string[] = [];
            let cursor: string | undefined;
            do {
                const page = await readExternalSessionHookInstallationInventoryPage({
                    activeServerDir: f.activeServerDir,
                    qualifiedAgent,
                    limit: 17,
                    ...(cursor ? { cursor } : {}),
                });
                if (!page.ok) throw new Error(`inventory failed: ${page.code}`);
                expect(page.records.length + page.diagnostics.length).toBeLessThanOrEqual(17);
                expect(page.diagnostics).toEqual([]);
                observedIds.push(...page.records.map((record) => record.installationId));
                cursor = page.nextCursor;
            } while (cursor);
            return observedIds;
        };

        const observedIds = await walk();
        expect(await walk()).toEqual(observedIds);
        expect([...observedIds].sort()).toEqual(expectedIds);
    });

    it('decodes only the requested filtered or global custody page', async () => {
        const f = await fixture();
        const qualifiedAgent = {
            pluginId: 'happier.agent.bounded-inventory',
            localId: 'bounded-inventory',
        };
        const firstInstallation = await installInventoryRecord({
            activeServerDir: f.activeServerDir,
            configDir: f.configDir,
            qualifiedAgent,
            hostInstallationId: 'bounded-000',
        });
        const baseline = JSON.parse(
            await readFile(recordPath(firstInstallation), 'utf8'),
        ) as Record<string, unknown>;
        for (let index = 1; index < 120; index += 1) {
            const installationId = `bounded-${String(index).padStart(3, '0')}`;
            const path = resolveExternalSessionHookInstallationRecordPath({
                activeServerDir: f.activeServerDir,
                qualifiedAgent,
                hostInstallationId: installationId,
            });
            await writeFile(path, JSON.stringify({
                ...baseline,
                hostInstallationId: installationId,
                installationIdentity: `installation-${installationId}`,
                executableIdentity: `executable-${installationId}`,
            }));
        }

        inventoryFilesystemBoundary.recordReads = 0;
        inventoryFilesystemBoundary.observe = true;
        try {
            const page =
                await readExternalSessionHookInstallationInventoryPage({
                    activeServerDir: f.activeServerDir,
                    qualifiedAgent,
                    limit: 1,
                });
            expect(page).toMatchObject({
                ok: true,
                records: [expect.any(Object)],
                diagnostics: [],
                nextCursor: expect.any(String),
            });
            expect(inventoryFilesystemBoundary.recordReads).toBe(1);

            inventoryFilesystemBoundary.recordReads = 0;
            const globalPage =
                await readExternalSessionHookInstallationInventoryPage({
                    activeServerDir: f.activeServerDir,
                    limit: 1,
                });
            expect(globalPage).toMatchObject({
                ok: true,
                records: [expect.any(Object)],
                diagnostics: [],
                nextCursor: expect.any(String),
            });
            expect(inventoryFilesystemBoundary.recordReads).toBe(1);
        } finally {
            inventoryFilesystemBoundary.observe = false;
        }
    });

    it('fails closed at the custody descriptor ceiling before record reads', async () => {
        const f = await fixture();
        const qualifiedAgent = {
            pluginId: 'happier.agent.descriptor-ceiling',
            localId: 'descriptor-ceiling',
        };
        const installed = await installInventoryRecord({
            activeServerDir: f.activeServerDir,
            configDir: f.configDir,
            qualifiedAgent,
            hostInstallationId: 'descriptor-ceiling-1',
        });

        inventoryFilesystemBoundary.observe = true;
        inventoryFilesystemBoundary.recordReads = 0;
        inventoryFilesystemBoundary.directoryPulls = 0;
        inventoryFilesystemBoundary.directoryCloses = 0;
        inventoryFilesystemBoundary.syntheticDirectoryEntries = 10_001;
        inventoryFilesystemBoundary.syntheticDirectoryPath = dirname(
            recordPath(installed),
        ).replaceAll('\\', '/');
        try {
            await expect(
                readExternalSessionHookInstallationInventoryPage({
                    activeServerDir: f.activeServerDir,
                    qualifiedAgent,
                    limit: 1,
                }),
            ).resolves.toEqual({
                ok: false,
                code: 'inventory_read_failed',
            });
            expect(inventoryFilesystemBoundary.recordReads).toBe(0);
            expect(inventoryFilesystemBoundary.directoryPulls).toBe(10_001);
            expect(inventoryFilesystemBoundary.directoryCloses).toBe(1);
        } finally {
            inventoryFilesystemBoundary.observe = false;
            inventoryFilesystemBoundary.syntheticDirectoryPath = null;
            inventoryFilesystemBoundary.syntheticDirectoryEntries = 0;
        }
    });

    it('binds cursors to the exact Agent filter and rejects limits above fifty', async () => {
        const f = await fixture();
        const firstAgent = { pluginId: 'happier.agent.first', localId: 'first' };
        const secondAgent = { pluginId: 'happier.agent.second', localId: 'second' };
        await Promise.all([
            installInventoryRecord({
                activeServerDir: f.activeServerDir,
                configDir: f.configDir,
                qualifiedAgent: firstAgent,
                hostInstallationId: 'first-1',
            }),
            installInventoryRecord({
                activeServerDir: f.activeServerDir,
                configDir: f.configDir,
                qualifiedAgent: firstAgent,
                hostInstallationId: 'first-2',
            }),
        ]);
        const first = await readExternalSessionHookInstallationInventoryPage({
            activeServerDir: f.activeServerDir,
            qualifiedAgent: firstAgent,
            limit: 1,
        });
        if (!first.ok || !first.nextCursor) throw new Error('expected paged inventory');

        await expect(readExternalSessionHookInstallationInventoryPage({
            activeServerDir: f.activeServerDir,
            qualifiedAgent: secondAgent,
            limit: 1,
            cursor: first.nextCursor,
        })).resolves.toEqual({ ok: false, code: 'invalid_cursor' });
        await expect(readExternalSessionHookInstallationInventoryPage({
            activeServerDir: f.activeServerDir,
            limit: 51,
        })).resolves.toEqual({ ok: false, code: 'invalid_limit' });
    });

    it('resumes after a deleted cursor record without requiring the descriptor to remain', async () => {
        const f = await fixture();
        const qualifiedAgent = {
            pluginId: 'happier.agent.cursor-deletion',
            localId: 'cursor-deletion',
        };
        const installations = await Promise.all([
            installInventoryRecord({
                activeServerDir: f.activeServerDir,
                configDir: f.configDir,
                qualifiedAgent,
                hostInstallationId: 'cursor-delete-a',
            }),
            installInventoryRecord({
                activeServerDir: f.activeServerDir,
                configDir: f.configDir,
                qualifiedAgent,
                hostInstallationId: 'cursor-delete-b',
            }),
            installInventoryRecord({
                activeServerDir: f.activeServerDir,
                configDir: f.configDir,
                qualifiedAgent,
                hostInstallationId: 'cursor-delete-c',
            }),
        ]);
        const first = await readExternalSessionHookInstallationInventoryPage({
            activeServerDir: f.activeServerDir,
            qualifiedAgent,
            limit: 1,
        });
        if (!first.ok || !first.nextCursor || first.records.length !== 1) {
            throw new Error('expected first cursor-deletion inventory page');
        }
        const cursorInstallation = installations.find(
            (input) => input.hostInstallationId === first.records[0]!.installationId,
        );
        if (!cursorInstallation) throw new Error('expected cursor installation');
        await rm(recordPath(cursorInstallation));

        const resumed = await readExternalSessionHookInstallationInventoryPage({
            activeServerDir: f.activeServerDir,
            qualifiedAgent,
            cursor: first.nextCursor,
        });

        expect(resumed).toMatchObject({ ok: true, diagnostics: [] });
        if (!resumed.ok) throw new Error('expected inventory to resume after deletion');
        expect(resumed.records.length).toBeGreaterThan(0);
        expect(resumed.records).not.toContainEqual(
            expect.objectContaining({ installationId: first.records[0]!.installationId }),
        );
    });

    it('filters before reading other Agent records and reports malformed records without guessing identity', async () => {
        const f = await fixture();
        const selectedAgent = { pluginId: 'happier.agent.selected', localId: 'selected' };
        const otherAgent = { pluginId: 'happier.agent.other', localId: 'other' };
        await installInventoryRecord({
            activeServerDir: f.activeServerDir,
            configDir: f.configDir,
            qualifiedAgent: selectedAgent,
            hostInstallationId: 'selected-1',
        });
        const otherPath = resolveExternalSessionHookInstallationRecordPath({
            activeServerDir: f.activeServerDir,
            qualifiedAgent: otherAgent,
            hostInstallationId: 'other-invalid',
        });
        await mkdir(dirname(otherPath), { recursive: true });
        await writeFile(otherPath, '{"foreignSecret":"must-not-leak"}');

        const filtered = await readExternalSessionHookInstallationInventoryPage({
            activeServerDir: f.activeServerDir,
            qualifiedAgent: selectedAgent,
        });
        expect(filtered).toMatchObject({
            ok: true,
            records: [{ installationId: 'selected-1', qualifiedAgent: selectedAgent }],
            diagnostics: [],
        });

        const unfiltered = await readExternalSessionHookInstallationInventoryPage({
            activeServerDir: f.activeServerDir,
        });
        expect(unfiltered).toMatchObject({
            ok: true,
            records: [{ installationId: 'selected-1' }],
            diagnostics: [{
                code: 'invalid_record',
                recordRef: expect.stringMatching(/^[a-f0-9]{64}$/u),
            }],
        });
        expect(JSON.stringify(unfiltered)).not.toContain('must-not-leak');
        expect(JSON.stringify(unfiltered)).not.toContain(otherAgent.pluginId);
        expect(JSON.stringify(unfiltered)).not.toContain(otherPath);
    });

    it('ignores configuration lock directories adjacent to Agent custody directories', async () => {
        const f = await fixture();
        const qualifiedAgent = {
            pluginId: 'happier.agent.lock-neighbor',
            localId: 'lock-neighbor',
        };
        const installed = await installInventoryRecord({
            activeServerDir: f.activeServerDir,
            configDir: f.configDir,
            qualifiedAgent,
            hostInstallationId: 'lock-neighbor-1',
        });
        const recordsRoot = dirname(dirname(recordPath(installed)));
        const lockDirectory = join(recordsRoot, 'configuration.lock');
        await mkdir(lockDirectory);
        await writeFile(join(lockDirectory, 'owner.json'), '{"pid":123}');

        await expect(readExternalSessionHookInstallationInventoryPage({
            activeServerDir: f.activeServerDir,
        })).resolves.toMatchObject({
            ok: true,
            records: [{ installationId: 'lock-neighbor-1' }],
            diagnostics: [],
        });
    });

    it.skipIf(process.platform === 'win32')(
        'reports an unreadable record as a bounded typed diagnostic',
        async () => {
            const f = await fixture();
            const qualifiedAgent = {
                pluginId: 'happier.agent.unreadable',
                localId: 'unreadable',
            };
            const installed = await installInventoryRecord({
                activeServerDir: f.activeServerDir,
                configDir: f.configDir,
                qualifiedAgent,
                hostInstallationId: 'unreadable-1',
            });
            await chmod(recordPath(installed), 0o000);

            const result = await readExternalSessionHookInstallationInventoryPage({
                activeServerDir: f.activeServerDir,
                qualifiedAgent,
            });
            expect(result).toMatchObject({
                ok: true,
                records: [],
                diagnostics: [{
                    code: 'record_read_failed',
                    recordRef: expect.stringMatching(/^[a-f0-9]{64}$/u),
                }],
            });
        },
    );
});
