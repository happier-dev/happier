import { describe, expect, it } from 'vitest';

import {
    CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1,
    CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1,
    CurrentUiContextSnapshotV1Schema,
    PluginUiContextEnrichmentV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import { projectParameterFreeRoute } from '@/track/parameterFreeRouteProjection';

import {
    composeCurrentUiContextSnapshot,
    hasCurrentSessionRoute,
    hasActiveDetailsWorkspace,
    readCurrentUiContextSettingsPage,
} from './currentUiContextModel';

function route(...segments: string[]) {
    return projectParameterFreeRoute(segments);
}

describe('composeCurrentUiContextSnapshot', () => {
    it('treats only the incumbent active scope details workspace as explicit pane context', () => {
        expect(hasActiveDetailsWorkspace({
            activeScopeId: 'active',
            scopes: {
                active: { details: { isOpen: true, focusedGroupId: 'focused' } },
                stale: { details: { isOpen: true, focusedGroupId: 'stale' } },
            },
        })).toBe(true);

        expect(hasActiveDetailsWorkspace({
            activeScopeId: 'active',
            scopes: {
                active: { details: { isOpen: false, focusedGroupId: 'focused' } },
                stale: { details: { isOpen: true, focusedGroupId: 'stale' } },
            },
        })).toBe(false);

        expect(hasActiveDetailsWorkspace({
            activeScopeId: 'active',
            scopes: {
                active: { details: { isOpen: true, focusedGroupId: null } },
            },
        })).toBe(false);
    });

    it('requires the focused Session owner to match the private route identity locally', () => {
        expect(hasCurrentSessionRoute('session-a', 'session-a')).toBe(true);
        expect(hasCurrentSessionRoute('session-a', 'session-b')).toBe(false);
        expect(hasCurrentSessionRoute(null, 'session-a')).toBe(false);
        expect(hasCurrentSessionRoute('session-a', '')).toBe(false);
    });

    it('reads external-plugin provenance from the resolved active Settings page', () => {
        expect(readCurrentUiContextSettingsPage({
            activePageId: 'pluginSettingsPage:calendar:agenda',
            tree: [{
                id: 'pluginSettingsPage:calendar:agenda',
                title: 'Calendar settings',
                keywords: [],
                pluginSettingsPage: { pluginId: 'calendar', pageId: 'agenda' },
            }],
        })).toMatchObject({
            title: 'Calendar settings',
            pluginSettingsPage: { pluginId: 'calendar', pageId: 'agenda' },
        });
    });

    it('uses the shared parameter-free route projection as its baseline', () => {
        const snapshot = composeCurrentUiContextSnapshot({
            route: route('session', '[id]', 'file'),
        });

        expect(snapshot).toEqual({
            navigation: {
                area: 'app',
                screen: 'session/:id/file',
                presentation: 'screen',
            },
            commands: [],
        });
        expect(CurrentUiContextSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
        expect(JSON.stringify(snapshot)).not.toContain('[id]');
    });

    it('projects current mount enrichment as opaque command descriptors and removes every optional field on clear', () => {
        const mounted = composeCurrentUiContextSnapshot({
            route: route('plugins', '[pluginId]', '[localId]'),
            mountEnrichment: {
                entity: {
                    kind: 'issue',
                    label: 'Issue A',
                    summary: 'Bound issue summary',
                    reference: { number: 1 },
                },
                detail: { state: 'open' },
                commands: [{
                    id: 'current-ui-command:1',
                    title: 'Open issue B',
                    description: 'Navigate to the related issue',
                    command: {
                        kind: 'openSurface',
                        destination: { pluginId: 'acme.review', localId: 'issues' },
                        input: { issueNumber: 2, privateQuery: 'do-not-disclose' },
                    },
                }],
            },
        } as never);

        expect(mounted).toEqual({
            navigation: {
                area: 'plugin',
                screen: 'page',
                presentation: 'screen',
            },
            entity: {
                kind: 'issue',
                label: 'Issue A',
                summary: 'Bound issue summary',
                reference: { number: 1 },
            },
            detail: { state: 'open' },
            commands: [{
                id: 'current-ui-command:1',
                title: 'Open issue B',
                description: 'Navigate to the related issue',
            }],
        });
        expect(JSON.stringify(mounted)).not.toContain('privateQuery');
        expect(mounted.commands[0]).not.toHaveProperty('command');

        const cleared = composeCurrentUiContextSnapshot({
            route: route('plugins', '[pluginId]', '[localId]'),
            mountEnrichment: null,
        } as never);
        expect(cleared).toEqual({
            navigation: {
                area: 'plugin',
                screen: 'page',
                presentation: 'screen',
            },
            commands: [],
        });
        expect(cleared).not.toHaveProperty('entity');
        expect(cleared).not.toHaveProperty('detail');
    });

    it('returns a valid explicit incomplete snapshot when host composition exceeds the canonical byte bound', () => {
        const envelopeBytes = new TextEncoder().encode(JSON.stringify({ detail: { padding: '' } })).byteLength;
        const enrichment = {
            detail: { padding: 'x'.repeat(CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1 - envelopeBytes) },
        } as const;

        expect(PluginUiContextEnrichmentV1Schema.safeParse(enrichment).success).toBe(true);

        const snapshot = composeCurrentUiContextSnapshot({
            route: route('settings', 'voice'),
            settings: { title: 'Voice settings' },
            mountEnrichment: { ...enrichment, commands: [] },
        } as never);

        expect(CurrentUiContextSnapshotV1Schema.safeParse(snapshot).success).toBe(true);
        expect(snapshot.detail).toEqual(CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1);
        expect(snapshot.commands).toEqual([]);
        expect(JSON.stringify(snapshot)).not.toContain('padding');
    });

    it('uses a visible modal kind before every lower-precedence fact without copying modal content', () => {
        expect(composeCurrentUiContextSnapshot({
            route: route('settings', 'voice'),
            visibleModalKind: 'confirm',
            focusedDetailsWorkspace: true,
            settings: { title: 'Voice settings' },
            sessionActive: true,
            session: {
                id: 'session-a',
                metadata: { summary: { text: 'PRIVATE_SESSION_TITLE', updatedAt: 1 } },
            },
            privacy: {
                shareSessionSummary: true,
                shareFilePaths: true,
                shareDeviceInventory: true,
            },
            mountEnrichment: {
                entity: { kind: 'issue', label: 'Issue A' },
                detail: { privateModalState: 'do-not-disclose' },
                commands: [{
                    id: 'current-ui-command:modal',
                    title: 'Open issue B',
                }],
            },
        })).toEqual({
            navigation: {
                area: 'modal',
                screen: 'confirm',
                presentation: 'modal',
            },
            commands: [],
        });
    });

    it('uses only an explicit focused details workspace before framework route facts', () => {
        expect(composeCurrentUiContextSnapshot({
            route: route('settings', 'voice'),
            focusedDetailsWorkspace: true,
            settings: { title: 'Voice settings' },
        })).toEqual({
            navigation: {
                area: 'workspace',
                screen: 'details',
                presentation: 'pane',
            },
            commands: [],
        });

        expect(composeCurrentUiContextSnapshot({
            route: route('session', '[id]'),
            focusedDetailsWorkspace: true,
            sessionActive: true,
            session: {
                id: 'session-a',
                metadata: { summary: { text: 'PRIVATE_SESSION_TITLE', updatedAt: 1 } },
            },
            privacy: {
                shareSessionSummary: true,
                shareFilePaths: true,
                shareDeviceInventory: false,
            },
        } as never)).toEqual({
            navigation: {
                area: 'workspace',
                screen: 'details',
                presentation: 'pane',
            },
            commands: [],
        });
    });

    it('uses the resolved Settings title instead of a route identity', () => {
        expect(composeCurrentUiContextSnapshot({
            route: route('settings', 'providers', '[connectionId]'),
            settings: { title: 'Provider connections' },
        })).toEqual({
            navigation: {
                area: 'settings',
                screen: 'settings/providers/:id',
                presentation: 'screen',
                title: 'Provider connections',
            },
            commands: [],
        });
    });

    it('preserves an admitted plugin Settings title on demand while classifying its navigation semantically', () => {
        expect(composeCurrentUiContextSnapshot({
            route: route('settings', 'plugins', '[pluginId]', '[pageId]'),
            settings: {
                title: 'PLUGIN_SETTINGS_LABEL_SENTINEL',
                pluginSettingsPage: true,
            },
        })).toEqual({
            navigation: {
                area: 'settings',
                screen: 'settings.plugin_page',
                presentation: 'screen',
                title: 'PLUGIN_SETTINGS_LABEL_SENTINEL',
            },
            commands: [],
        });
    });

    it('uses an admitted plugin page label without exposing the page identity or subpath', () => {
        expect(composeCurrentUiContextSnapshot({
            route: route('plugins', '[pluginId]', '[localId]', '[...subPath]'),
            pluginPage: { label: 'Calendar' },
        })).toEqual({
            navigation: {
                area: 'plugin',
                screen: 'page',
                presentation: 'screen',
                title: 'Calendar',
            },
            commands: [],
        });
    });

    it('admits Session and machine areas only from their current canonical selector facts', () => {
        expect(composeCurrentUiContextSnapshot({
            route: route('session', '[id]', 'file'),
            sessionActive: true,
        })).toEqual({
            navigation: {
                area: 'session',
                screen: 'session/:id/file',
                presentation: 'screen',
            },
            commands: [],
        });

        expect(composeCurrentUiContextSnapshot({
            route: route('machine', '[id]', 'terminal'),
            machineActive: true,
        })).toEqual({
            navigation: {
                area: 'machine',
                screen: 'machine/:id/terminal',
                presentation: 'screen',
            },
            commands: [],
        });
    });

    it('enriches current Session and machine routes with only privacy-approved incumbent display titles', () => {
        const session = composeCurrentUiContextSnapshot({
            route: route('session', '[id]', 'file'),
            sessionActive: true,
            session: {
                id: 'session-a',
                metadata: {
                    summary: { text: 'SESSION_TITLE_SENTINEL', updatedAt: 1 },
                    path: '/Users/alice/SECRET_SESSION_WORKSPACE',
                },
            },
            privacy: {
                shareSessionSummary: true,
                shareFilePaths: false,
                shareDeviceInventory: false,
            },
        } as never);

        expect(session.navigation).toEqual({
            area: 'session',
            screen: 'session/:id/file',
            title: 'SESSION_TITLE_SENTINEL',
            presentation: 'screen',
        });
        expect(JSON.stringify(session)).not.toContain('SECRET_SESSION_WORKSPACE');

        const sessionSummaryWithPath = composeCurrentUiContextSnapshot({
            route: route('session', '[id]', 'file'),
            sessionActive: true,
            session: {
                id: 'session-a',
                metadata: {
                    summary: {
                        text: 'Inspect /Users/alice/SECRET_SESSION_WORKSPACE',
                        updatedAt: 1,
                    },
                },
            },
            privacy: {
                shareSessionSummary: true,
                shareFilePaths: false,
                shareDeviceInventory: false,
            },
        } as never);
        expect(sessionSummaryWithPath.navigation.title).toBe('Inspect <path_redacted>');
        expect(JSON.stringify(sessionSummaryWithPath)).not.toContain('SECRET_SESSION_WORKSPACE');

        const sessionSummaryWithWindowsPath = composeCurrentUiContextSnapshot({
            route: route('session', '[id]', 'file'),
            sessionActive: true,
            session: {
                id: 'session-a',
                metadata: {
                    summary: {
                        text: 'Inspect C:\\Users\\alice\\SECRET_AUTOMATIC_WORKSPACE',
                        updatedAt: 1,
                    },
                },
            },
            privacy: {
                shareSessionSummary: true,
                shareFilePaths: false,
                shareDeviceInventory: false,
            },
        } as never);
        expect(sessionSummaryWithWindowsPath.navigation.title).toBe('Inspect <path_redacted>');
        expect(JSON.stringify(sessionSummaryWithWindowsPath)).not.toContain('SECRET_AUTOMATIC_WORKSPACE');

        const machine = composeCurrentUiContextSnapshot({
            route: route('machine', '[id]', 'terminal'),
            machineActive: true,
            machine: {
                id: 'machine-a',
                metadata: { displayName: 'MACHINE_LABEL_SENTINEL' },
            },
            privacy: {
                shareSessionSummary: false,
                shareFilePaths: false,
                shareDeviceInventory: true,
            },
        } as never);

        expect(machine.navigation).toEqual({
            area: 'machine',
            screen: 'machine/:id/terminal',
            title: 'MACHINE_LABEL_SENTINEL',
            presentation: 'screen',
        });
    });

    it('suppresses framework titles when their disclosure gate is closed and keeps path-derived Session titles behind file-path sharing', () => {
        const privateSession = composeCurrentUiContextSnapshot({
            route: route('session', '[id]', 'file'),
            sessionActive: true,
            session: {
                id: 'session-a',
                metadata: {
                    summary: { text: 'PRIVATE_SESSION_TITLE', updatedAt: 1 },
                    path: '/Users/alice/SECRET_SESSION_WORKSPACE',
                },
            },
            privacy: {
                shareSessionSummary: false,
                shareFilePaths: true,
                shareDeviceInventory: true,
            },
        } as never);
        expect(privateSession.navigation).not.toHaveProperty('title');
        expect(JSON.stringify(privateSession)).not.toContain('PRIVATE_SESSION_TITLE');

        const privateMachine = composeCurrentUiContextSnapshot({
            route: route('machine', '[id]', 'terminal'),
            machineActive: true,
            machine: {
                id: 'machine-a',
                metadata: { displayName: 'PRIVATE_MACHINE_LABEL' },
            },
            privacy: {
                shareSessionSummary: true,
                shareFilePaths: true,
                shareDeviceInventory: false,
            },
        } as never);
        expect(privateMachine.navigation).not.toHaveProperty('title');
        expect(JSON.stringify(privateMachine)).not.toContain('PRIVATE_MACHINE_LABEL');

        const pathOnlySession = composeCurrentUiContextSnapshot({
            route: route('session', '[id]', 'file'),
            sessionActive: true,
            session: {
                id: 'session-a',
                metadata: { path: '/Users/alice/SECRET_SESSION_WORKSPACE' },
            },
            privacy: {
                shareSessionSummary: true,
                shareFilePaths: false,
                shareDeviceInventory: false,
            },
        } as never);
        expect(pathOnlySession.navigation).not.toHaveProperty('title');
        expect(JSON.stringify(pathOnlySession)).not.toContain('SECRET_SESSION_WORKSPACE');

        const pathAuthorizedSession = composeCurrentUiContextSnapshot({
            route: route('session', '[id]', 'file'),
            sessionActive: true,
            session: {
                id: 'session-a',
                metadata: { path: '/Users/alice/SECRET_SESSION_WORKSPACE' },
            },
            privacy: {
                shareSessionSummary: true,
                shareFilePaths: true,
                shareDeviceInventory: false,
            },
        } as never);
        expect(pathAuthorizedSession.navigation.title).toBe('SECRET_SESSION_WORKSPACE');
    });

    it('uses a mobile tab only when no more-specific route fact is present', () => {
        expect(composeCurrentUiContextSnapshot({
            route: route(),
            mobileTab: 'projects',
        })).toEqual({
            navigation: {
                area: 'app',
                screen: 'tab.projects',
                presentation: 'screen',
            },
            commands: [],
        });

        expect(composeCurrentUiContextSnapshot({
            route: route('machine', '[id]', 'terminal'),
            mobileTab: 'projects',
        })).toEqual({
            navigation: {
                area: 'app',
                screen: 'machine/:id/terminal',
                presentation: 'screen',
            },
            commands: [],
        });
    });

    it('removes retired Session and machine framework enrichment instead of retaining it', () => {
        const active = composeCurrentUiContextSnapshot({
            route: route('session', '[id]', 'file'),
            sessionActive: true,
        });
        const retired = composeCurrentUiContextSnapshot({
            route: route('session', '[id]', 'file'),
            session: {
                id: 'session-a',
                metadata: { summary: { text: 'STALE_SESSION_TITLE', updatedAt: 1 } },
            },
            privacy: {
                shareSessionSummary: true,
                shareFilePaths: true,
                shareDeviceInventory: true,
            },
        });

        expect(active.navigation.area).toBe('session');
        expect(retired).toEqual({
            navigation: {
                area: 'app',
                screen: 'session/:id/file',
                presentation: 'screen',
            },
            commands: [],
        });

        const activeMachine = composeCurrentUiContextSnapshot({
            route: route('machine', '[id]', 'terminal'),
            machineActive: true,
        });
        const retiredMachine = composeCurrentUiContextSnapshot({
            route: route('machine', '[id]', 'terminal'),
            machine: {
                id: 'machine-a',
                metadata: { displayName: 'STALE_MACHINE_LABEL' },
            },
            privacy: {
                shareSessionSummary: true,
                shareFilePaths: true,
                shareDeviceInventory: true,
            },
        });
        expect(activeMachine.navigation.area).toBe('machine');
        expect(retiredMachine.navigation.area).toBe('app');
    });
});
