import { describe, expect, it } from 'vitest';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol';

import { buildLocalServiceLauncherSnapshot } from './suggestions';
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
    it('projects scripts, inventory entries, and registered previews into stable launcher targets', () => {
        const snapshot = buildLocalServiceLauncherSnapshot({
            machineId: 'machine-a',
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
                previewId: 'preview-a',
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
                originMode: 'path',
                browserTarget: {
                    kind: 'localServicePreview',
                    targetId: 'preview-a',
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
            ['preview:preview-a', 'registered_preview', 'available', ['open_preview']],
            ['inventory:inventory-a', 'inventory_entry', 'available', ['open_preview', 'register_preview']],
            ['package:web:dev', 'package_script', 'unavailable', []],
            ['inventory:inventory-stale', 'inventory_entry', 'unavailable', []],
        ]);
        expect(snapshot.targets[0]?.browserTarget?.kind).toBe('localServicePreview');
        expect(snapshot.targets[1]).toMatchObject({
            title: 'Local Vite App',
            kind: 'vite',
            browserTarget: { targetId: 'preview-a' },
        });
        expect(snapshot.targets[2]?.unavailableReason).toBe('launch_unavailable');
        expect(snapshot.targets[3]?.unavailableReason).toBe('stale_service');
    });

    it('mints an externalUrl loopback open target for a listening loopback entry without a preview', () => {
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
        expect(target?.actions).toEqual(['open']);
        expect(target?.browserTarget).toMatchObject({
            kind: 'externalUrl',
            targetId: 'inventory-loopback:inventory-a',
            url: 'http://127.0.0.1:5173/',
        });
    });

    it('mints an HTTPS open target from the daemon-detected endpoint scheme', () => {
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
        expect(snapshot.targets[0]?.browserTarget).toMatchObject({
            kind: 'externalUrl',
            url: 'https://127.0.0.1:8443/',
        });
    });

    it('keeps unknown-scheme loopback entries visible but disables open with a reason', () => {
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
            unavailableReason: 'endpoint_scheme_unknown',
            actions: [],
        });
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
        expect(snapshot.targets[0]?.actions).toEqual(['open', 'terminate_detected']);
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

        expect(disabled.targets[0]?.actions).toEqual(['open']);
        expect(unowned.targets[0]?.actions).toEqual(['open']);
        expect(unestablished.targets[0]?.actions).toEqual(['open']);
    });

    it('bracket-wraps IPv6 loopback hosts in the minted open url', () => {
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
        expect(snapshot.targets[0]?.browserTarget).toMatchObject({
            kind: 'externalUrl',
            url: 'http://[::1]:5173/',
        });
    });

    it('maps wildcard binds to a reachable loopback by family', () => {
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
        expect(ipv4.targets[0]?.browserTarget).toMatchObject({ url: 'http://127.0.0.1:5173/' });

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
        expect(ipv6.targets[0]?.browserTarget).toMatchObject({ url: 'http://[::1]:5173/' });
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
    });
});
