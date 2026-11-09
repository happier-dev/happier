import { describe, expect, it } from 'vitest';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol';
import { LOCAL_SERVICE_LAUNCH_TARGET_COMMAND_PREVIEW_MAX_LENGTH } from '@happier-dev/protocol/local/services/launcher/v1';

import { buildLocalServiceLauncherSnapshot } from './suggestions';
import { previewIdForInventoryEntry } from '../preview/registry';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';

function inventoryEntry(overrides: Partial<NormalizedLocalServiceInventoryEntry> = {}): NormalizedLocalServiceInventoryEntry {
    return {
        id: 'inventory-a',
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        endpoint: {
            scheme: 'http',
            host: '127.0.0.1',
            port: 5173,
            probeState: 'ready',
            probedAt: 2_000,
        },
        port: 5173,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 2_000,
        state: 'listening',
        source: 'detected',
        presentation: {
            pageTitle: 'Local Vite App',
            pageTitleSource: 'html_title',
            displayName: 'Vite',
            folderLabel: 'web',
            addressLabel: 'localhost:5173',
        },
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'medium',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
        provenance: {
            process: {
                pid: 400,
                ppid: 300,
                lineagePids: [400, 300],
                command: 'npm run dev',
                cwd: '/repo/web',
                redacted: true,
            },
        },
        classification: {
            kind: 'vite',
            displayName: 'Vite',
            confidence: 'high',
            lowSignal: false,
            signals: ['vite'],
        },
        ...overrides,
    };
}


describe('buildLocalServiceLauncherSnapshot', () => {
    it.each([
        { kind: 'short', command: 'python -m http.server 5173', expected: 'python -m http.server 5173' },
        { kind: 'clipped Unicode', command: `printf '${'x'.repeat(LOCAL_SERVICE_LAUNCH_TARGET_COMMAND_PREVIEW_MAX_LENGTH - 10)}😀more text'`,
            expected: `printf '${'x'.repeat(LOCAL_SERVICE_LAUNCH_TARGET_COMMAND_PREVIEW_MAX_LENGTH - 10)}…` },
    ])('publishes a $kind command preview for a project declaration', ({ command, expected }) => {
        const snapshot = buildLocalServiceLauncherSnapshot({ machineId: 'machine-a', updatedAt: 1,
            runTargets: [{ id: 'declared-web', cwd: '/repo', workspaceId: 'workspace-a',
                workspace: { serverId: 'home', machineId: 'machine-a', workspaceId: 'workspace-a', rootPath: '/repo' },
                declaration: { workspaceRefId: 'workspace-a', selection: { kind: 'manifest', name: 'web' } },
                title: 'Web', displayMatch: { command, port: 5173 } }],
            previewResources: [], inventoryEntries: [],
        });
        const parsed = LocalServiceLauncherSnapshotV1Schema.parse(snapshot);
        const preview = parsed.targets[0]?.commandPreview;
        expect(preview).toBe(expected);
        expect(parsed.targets[0]).toMatchObject({ source: 'managed_service', declaration: {
            workspaceRefId: 'workspace-a', selection: { kind: 'manifest', name: 'web' },
        } });
    });
    it.each(['listening', 'stale'] as const)('names a %s listener only from its associated nested accepted checkout and scoped declarations', state => {
        const parent = { id: 'parent', cwd: '/repo', workspaceId: 'workspace-a',
            workspace: { serverId: 'home', machineId: 'machine-a', workspaceId: 'workspace-a', rootPath: '/repo' },
            declaration: { workspaceRefId: 'workspace-a', selection: { kind: 'manifest', name: 'api' } },
            title: 'Parent api', displayMatch: { port: 5173 } } as const;
        const child = { ...parent, id: 'child', cwd: '/repo/b', workspaceId: 'workspace-b',
            workspace: { ...parent.workspace, workspaceId: 'workspace-b', rootPath: '/repo/b' },
            declaration: { workspaceRefId: 'workspace-b', selection: { kind: 'manifest', name: 'web' } }, title: 'Child web' } as const;
        const entry = inventoryEntry({ state, provenance: {
            workspace: { id: 'workspace-b', path: '/repo/b', association: 'cwd_containment' },
            process: { pid: 400, lineagePids: [400], command: 'node web.js', cwd: '/repo/b/src', redacted: true },
        } });
        for (const workspaceScopePaths of [undefined, ['/repo/b']]) {
            const input = { machineId: 'machine-a', updatedAt: 1, previewResources: [], inventoryEntries: [entry], workspaceScopePaths };
            const parentOnly = buildLocalServiceLauncherSnapshot({ ...input, runTargets: [parent] });
            expect(parentOnly.targets.find(target => target.source === 'inventory_entry')?.title).toBe('Local Vite App');
            const unassociated = { ...entry, provenance: { process: entry.provenance?.process } };
            expect(buildLocalServiceLauncherSnapshot({ ...input, inventoryEntries: [unassociated], runTargets: [parent] })
                .targets.find(target => target.source === 'inventory_entry')?.title).toBe('Local Vite App');
            const withChild = buildLocalServiceLauncherSnapshot({ ...input, runTargets: [parent, child] });
            expect(withChild.targets.find(target => target.source === 'inventory_entry')?.title).toBe('Child web');
        }
        // A path-only association still selects the exact accepted root, not its parent.
        const pathOnly = { ...entry, provenance: { ...entry.provenance,
            workspace: { path: '/repo/b', association: 'cwd_containment' as const } } };
        expect(buildLocalServiceLauncherSnapshot({ machineId: 'machine-a', updatedAt: 1,
            runTargets: [parent, child], previewResources: [], inventoryEntries: [pathOnly],
        }).targets.find(target => target.source === 'inventory_entry')?.title).toBe('Child web');
    });
    it('projects a long observed process command into the existing preview bound without losing the listener', () => {
        const command = `node server.js --description ${'x'.repeat(1_500)}`;
        const snapshot = buildLocalServiceLauncherSnapshot({ machineId: 'machine-a', updatedAt: 1,
            runTargets: [], previewResources: [], inventoryEntries: [inventoryEntry({
                provenance: { process: { pid: 400, lineagePids: [400], cwd: '/repo/web', command, redacted: true } },
            })],
        });
        const parsed = LocalServiceLauncherSnapshotV1Schema.parse(snapshot);
        expect(parsed.targets).toHaveLength(1);
        expect(parsed.targets[0]?.commandPreview?.endsWith('…')).toBe(true);
        expect(command.startsWith(parsed.targets[0]?.commandPreview?.slice(0, -1) ?? '')).toBe(true);
        expect(parsed.targets[0]?.sourceClass).toEqual({ kind: 'inventory_entry', inventoryEntryId: 'inventory-a' });
    });
    it('projects preview access only through a currently listening Service', () => {
        const previewId = previewIdForInventoryEntry('account-a', 'machine-a', 'session-a', 'inventory-a');
        const preview = {
            previewId, sessionId: 'session-a', machineId: 'machine-a',
            owner: { kind: 'session' as const, id: 'session-a' },
            target: { scheme: 'http' as const, host: '127.0.0.1', port: 5173 },
            initialPath: { pathname: '/', search: '' }, display: { title: 'App', addressLabel: 'localhost:5173' }, originMode: 'host' as const,
        };
        const input = { machineId: 'machine-a', accountId: 'account-a', updatedAt: 3_000, runTargets: [],
            // Retained registrations never multiply the Services rows published per scan.
            previewResources: [preview, ...Array.from({ length: 128 }, (_, index) => ({ ...preview, previewId: `preview-z-${index}` }))] };
        const withListener = buildLocalServiceLauncherSnapshot({ ...input, inventoryEntries: [inventoryEntry()] });
        expect(withListener.targets).toHaveLength(1);
        expect(withListener.targets.find((target) => target.source === 'inventory_entry')).toMatchObject({ source: 'inventory_entry', actions: ['open_preview', 'register_preview'], browserTarget: { kind: 'localServicePreview', targetId: previewId } });
        const withoutListener = buildLocalServiceLauncherSnapshot({ ...input, inventoryEntries: [] });
        expect(withoutListener.targets).toHaveLength(0);
        const foreign = buildLocalServiceLauncherSnapshot({ ...input, inventoryEntries: [inventoryEntry({ machineId: 'other' })] });
        expect(foreign.targets).toHaveLength(1);
        const stale = buildLocalServiceLauncherSnapshot({ ...input, inventoryEntries: [inventoryEntry({ state: 'stale' })] });
        expect(stale.targets).toHaveLength(1);
        expect(stale.targets[0]).toMatchObject({ source: 'inventory_entry', state: 'unavailable', actions: [] });
        expect(stale.targets[0]?.browserTarget).toBeUndefined();
    });
    it('projects scripts, inventory entries, and registered previews into stable launcher targets', () => {
        const previewId = previewIdForInventoryEntry('account-a', 'machine-a', 'session-a', 'inventory-a');
        const snapshot = buildLocalServiceLauncherSnapshot({
            machineId: 'machine-a',
            accountId: 'account-a',
            sessionId: 'session-a',
            updatedAt: 3_000,
            runTargets: [{
                id: 'web:dev',
                cwd: '/repo/web',
                packageName: 'web',
                packageManager: 'npm',
                scriptName: 'dev',
                command: 'vite --host 127.0.0.1',
                launchIntent: {
                    kind: 'packageScript',
                    packageManager: 'npm',
                    cwd: '/repo/web',
                    scriptName: 'dev',
                },
            }],
            inventoryEntries: [
                inventoryEntry(),
                inventoryEntry({
                    id: 'inventory-stale',
                    port: 8080,
                    state: 'stale',
                    presentation: { addressLabel: 'localhost:8080' },
                }),
            ],
            previewResources: [{
                previewId,
                sessionId: 'session-a',
                machineId: 'machine-a',
                owner: { kind: 'session', id: 'session-a' },
                target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                initialPath: { pathname: '/', search: '' },
                display: {
                    title: 'Local Vite App',
                    addressLabel: 'localhost:5173',
                    folderLabel: 'web',
                    iconToken: 'vite',
                },
                originMode: 'host',
                browserTarget: {
                    kind: 'localServicePreview',
                    targetId: previewId,
                    sessionId: 'session-a',
                    machineId: 'machine-a',
                    display: {
                        title: 'Local Vite App',
                        addressLabel: 'localhost:5173',
                        folderLabel: 'web',
                        iconToken: 'vite',
                    },
                },
            }],
        });

        expect(LocalServiceLauncherSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
        expect(snapshot.targets.map((target) => [target.id, target.source, target.state, target.actions])).toEqual([
            ['inventory:inventory-a', 'inventory_entry', 'available', ['open_preview', 'register_preview']],
            ['package:web:dev', 'package_script', 'unavailable', []],
            ['inventory:inventory-stale', 'inventory_entry', 'unavailable', []],
        ]);
        expect(snapshot.targets[0]?.browserTarget?.kind).toBe('localServicePreview');
        expect(snapshot.targets[0]).toMatchObject({
            title: 'Local Vite App',
            kind: 'vite',
            browserTarget: { targetId: previewId },
        });
        expect(snapshot.targets[1]?.unavailableReason).toBe('launch_unavailable');
        expect(snapshot.targets[1]).not.toHaveProperty('sessionId');
        expect(snapshot.targets[2]?.unavailableReason).toBe('stale_service');
    });

    it('requires canonical preview registration rather than handing a remote viewer loopback', () => {
        const snapshot = buildLocalServiceLauncherSnapshot({
            machineId: 'machine-a',
            sessionId: 'session-a',
            updatedAt: 3_000,
            runTargets: [],
            inventoryEntries: [inventoryEntry()],
            previewResources: [],
        });

        expect(LocalServiceLauncherSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
        const target = snapshot.targets[0];
        expect(target?.state).toBe('available');
        expect(target?.actions).toEqual(['register_preview']);
        expect(target?.browserTarget).toBeUndefined();
        expect(target).not.toHaveProperty('sessionId');
    });

    it('attributes inventory targets only when the scanner recorded an originating session', () => {
        const snapshot = buildLocalServiceLauncherSnapshot({
            machineId: 'machine-a',
            sessionId: 'requesting-session',
            updatedAt: 3_000,
            runTargets: [],
            inventoryEntries: [
                inventoryEntry({ id: 'owned', provenance: { session: { id: 'origin-session' } } }),
                inventoryEntry({ id: 'unowned', port: 5174 }),
                inventoryEntry({ id: 'stale', port: 5175, state: 'stale' }),
            ],
            previewResources: [],
        });

        expect(snapshot.sessionId).toBe('requesting-session');
        expect(snapshot.targets.find((target) => target.id === 'inventory:owned')?.sessionId).toBe('origin-session');
        expect(snapshot.targets.find((target) => target.id === 'inventory:unowned')).not.toHaveProperty('sessionId');
        expect(snapshot.targets.find((target) => target.id === 'inventory:stale')).not.toHaveProperty('sessionId');
    });

    it('routes detected HTTPS services through the same preview registration owner', () => {
        const snapshot = buildLocalServiceLauncherSnapshot({
            machineId: 'machine-a',
            sessionId: 'session-a',
            updatedAt: 3_000,
            runTargets: [],
            inventoryEntries: [inventoryEntry({
                port: 8443,
                presentation: { addressLabel: 'localhost:8443', displayName: 'Secure app' },
                endpoint: {
                    scheme: 'https',
                    host: '127.0.0.1',
                    port: 8443,
                    probeState: 'ready',
                    probedAt: 2_000,
                },
            })],
            previewResources: [],
        });

        expect(LocalServiceLauncherSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
        expect(snapshot.targets[0]?.browserTarget).toBeUndefined();
        expect(snapshot.targets[0]?.actions).toEqual(['register_preview']);
    });

    it('keeps unknown-scheme loopback entries resolvable through preview registration', () => {
        const snapshot = buildLocalServiceLauncherSnapshot({
            machineId: 'machine-a',
            sessionId: 'session-a',
            updatedAt: 3_000,
            runTargets: [],
            inventoryEntries: [inventoryEntry({
                endpoint: {
                    scheme: 'unknown',
                    host: '127.0.0.1',
                    port: 5173,
                    probeState: 'unknown',
                    probedAt: 2_000,
                    reasonCode: 'endpoint_probe_failed',
                },
            })],
            previewResources: [],
        });

        expect(LocalServiceLauncherSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
        expect(snapshot.targets[0]).toMatchObject({
            source: 'inventory_entry',
            state: 'available',
            actions: ['register_preview'],
        });
        expect(snapshot.targets[0]).not.toHaveProperty('unavailableReason');
        expect(snapshot.targets[0]).not.toHaveProperty('browserTarget');
    });

    it('advertises terminate for an eligible detected inventory entry', () => {
        const snapshot = buildLocalServiceLauncherSnapshot({
            machineId: 'machine-a',
            sessionId: 'session-a',
            updatedAt: 3_000,
            runTargets: [],
            inventoryEntries: [inventoryEntry({
                id: 'terminable-a',
                port: 5174,
                // `high` is what eligibility now requires: a terminal-registry match or the
                // daemon's own OS identity. The old gate accepted `medium`, which every listener
                // with a pid reached, so it decided nothing.
                processOwnershipConfidence: 'high',
                presentation: { addressLabel: 'localhost:5174' },
            })],
            previewResources: [],
            terminateDetectedEnabled: true,
        });

        expect(LocalServiceLauncherSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
        expect(snapshot.targets[0]?.actions).toEqual(['register_preview', 'terminate_detected']);
    });

    it('does not advertise terminate for unowned or disabled detected inventory entries', () => {
        const disabled = buildLocalServiceLauncherSnapshot({
            machineId: 'machine-a',
            sessionId: 'session-a',
            updatedAt: 3_000,
            runTargets: [],
            inventoryEntries: [inventoryEntry({ id: 'disabled-a' })],
            previewResources: [],
            terminateDetectedEnabled: false,
        });
        const unowned = buildLocalServiceLauncherSnapshot({
            machineId: 'machine-a',
            sessionId: 'session-a',
            updatedAt: 4_000,
            runTargets: [],
            inventoryEntries: [inventoryEntry({
                id: 'unowned-a',
                processOwnershipConfidence: 'low',
                workspaceAssociationConfidence: 'medium',
            })],
            previewResources: [],
            terminateDetectedEnabled: true,
        });

        // `medium` means the platform could not establish who owns the process. The fixture
        // default sits there deliberately: it is the grade the old `>= medium` gate accepted for
        // every listener that merely had a pid, and it must now be refused.
        const unestablished = buildLocalServiceLauncherSnapshot({
            machineId: 'machine-a',
            sessionId: 'session-a',
            updatedAt: 5_000,
            runTargets: [],
            inventoryEntries: [inventoryEntry({ id: 'unestablished-a' })],
            previewResources: [],
            terminateDetectedEnabled: true,
        });

        expect(disabled.targets[0]?.actions).toEqual(['register_preview']);
        expect(unowned.targets[0]?.actions).toEqual(['register_preview']);
        expect(unestablished.targets[0]?.actions).toEqual(['register_preview']);
    });

    it('routes IPv6 listeners through canonical preview registration', () => {
        const snapshot = buildLocalServiceLauncherSnapshot({
            machineId: 'machine-a',
            sessionId: 'session-a',
            updatedAt: 3_000,
            runTargets: [],
            inventoryEntries: [inventoryEntry({
                id: 'inventory-ipv6',
                address: { kind: 'loopback', host: '::1', family: 'ipv6' },
                endpoint: {
                    scheme: 'http',
                    host: '::1',
                    port: 5173,
                    probeState: 'ready',
                    probedAt: 2_000,
                },
            })],
            previewResources: [],
        });
        expect(snapshot.targets[0]?.browserTarget).toBeUndefined();
        expect(snapshot.targets[0]?.actions).toEqual(['register_preview']);
    });

    it('leaves wildcard endpoint normalization to preview registration', () => {
        const ipv4 = buildLocalServiceLauncherSnapshot({
            machineId: 'machine-a',
            updatedAt: 3_000,
            runTargets: [],
            inventoryEntries: [inventoryEntry({
                id: 'inventory-wild4',
                address: { kind: 'wildcard', host: '0.0.0.0', family: 'ipv4' },
            })],
            previewResources: [],
        });
        expect(ipv4.targets[0]?.browserTarget).toBeUndefined();
        expect(ipv4.targets[0]?.actions).toEqual(['register_preview']);

        const ipv6 = buildLocalServiceLauncherSnapshot({
            machineId: 'machine-a',
            updatedAt: 3_000,
            runTargets: [],
            inventoryEntries: [inventoryEntry({
                id: 'inventory-wild6',
                address: { kind: 'wildcard', host: '::', family: 'ipv6' },
                endpoint: {
                    scheme: 'http',
                    host: '::1',
                    port: 5173,
                    probeState: 'ready',
                    probedAt: 2_000,
                },
            })],
            previewResources: [],
        });
        expect(ipv6.targets[0]?.browserTarget).toBeUndefined();
        expect(ipv6.targets[0]?.actions).toEqual(['register_preview']);
    });

    it('does not mint an open target for a non-loopback (LAN) listening entry', () => {
        const snapshot = buildLocalServiceLauncherSnapshot({
            machineId: 'machine-a',
            updatedAt: 3_000,
            runTargets: [],
            inventoryEntries: [inventoryEntry({
                id: 'inventory-lan',
                address: { kind: 'lan', host: '192.168.1.5', family: 'ipv4' },
                endpoint: undefined,
            })],
            previewResources: [],
        });
        const target = snapshot.targets[0];
        expect(target?.actions).toEqual(['register_preview']);
        expect(target).not.toHaveProperty('browserTarget');
    });


    it('projects terminal URL and workspace file asset candidates as fail-closed launcher targets', () => {
        const snapshot = buildLocalServiceLauncherSnapshot({
            machineId: 'machine-a',
            sessionId: 'session-a',
            updatedAt: 3_000,
            runTargets: [],
            inventoryEntries: [],
            previewResources: [],
            terminalUrlCandidates: [{
                sourceId: 'terminal-candidate-a',
                addressLabel: 'localhost:5173/login',
                title: 'Login page',
                cwd: '/repo/web',
            }],
            workspaceFileAssetCandidates: [{
                sourceId: 'asset-candidate-a',
                assetRef: 'asset-ref-a',
                title: 'App screenshot',
                mediaType: 'image/png',
                workspaceId: 'workspace-a',
            }],
        });

        expect(LocalServiceLauncherSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
        expect(snapshot.targets.map((target) => [target.id, target.source, target.state, target.unavailableReason, target.actions])).toEqual([
            ['terminal-url:terminal-candidate-a', 'terminal_url', 'unavailable', 'terminal_url_unresolved', []],
            ['workspace-file-asset:asset-ref-a', 'workspace_file_asset', 'unavailable', 'workspace_file_asset_preview_unavailable', []],
        ]);
        expect(snapshot.targets[0]).toMatchObject({
            title: 'Login page',
            subtitle: 'localhost:5173/login',
            sourceClass: {
                kind: 'terminal_url',
                sourceId: 'terminal-candidate-a',
                addressLabel: 'localhost:5173/login',
            },
        });
        expect(snapshot.targets[0]).not.toHaveProperty('commandPreview');
        expect(snapshot.targets[0]).not.toHaveProperty('sessionId');
        expect(snapshot.targets[1]).toMatchObject({
            workspaceId: 'workspace-a',
            title: 'App screenshot',
            subtitle: 'image/png',
            sourceClass: {
                kind: 'workspace_file_asset',
                sourceId: 'asset-candidate-a',
                assetRef: 'asset-ref-a',
                mediaType: 'image/png',
            },
        });
        expect(snapshot.targets[1]).not.toHaveProperty('commandPreview');
        expect(snapshot.targets[1]).not.toHaveProperty('sessionId');
    });
});
