import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import type { RememberedEngineSelectionV1 } from '@/sync/domains/sessionAuthoring/rememberedEngineSelections';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { useNewSessionAgentAuthoringOptionsState } from './useNewSessionAgentAuthoringOptionsState';

type PersistedDraft = Readonly<{
    agentType?: 'claude' | 'codex' | null;
    backendTarget?: unknown;
    modelId?: string | null;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: Readonly<{
        v: 1;
        updatedAt: number;
        overrides: Readonly<Record<string, Readonly<{ updatedAt: number; value: string }>>>;
    }> | null;
}>;

let latestSetSessionConfigOptionOverride: ((configId: string, value: string) => void) | null = null;

function HookProbe(props: Readonly<{
    agentType?: 'claude' | 'codex';
    backendTarget?: BackendTargetRefV1;
    persistedDraft: PersistedDraft | null;
    rememberedSelection?: RememberedEngineSelectionV1 | null;
}>) {
    const params = {
        agentType: props.agentType ?? 'claude',
        hydratedTempAuthoringDraft: null,
        hydratedPersistedAuthoringDraft: props.persistedDraft,
        rememberedEngineSelection: props.rememberedSelection ?? null,
        backendTarget: props.backendTarget ?? { kind: 'builtInAgent', agentId: props.agentType ?? 'claude' },
    };
    const state = useNewSessionAgentAuthoringOptionsState(params);
    latestSetSessionConfigOptionOverride = state.setSessionConfigOptionOverride;

    return (
        <>
            <Text testID="model-mode">
                {state.modelMode}
            </Text>
            <Text testID="session-mode-id">
                {state.acpSessionModeId ?? 'none'}
            </Text>
            <Text testID="overrides-json">
                {JSON.stringify(state.sessionConfigOptionOverrides)}
            </Text>
        </>
    );
}

describe('useNewSessionAgentAuthoringOptionsState', () => {
    it('preserves exact nonblank opaque mode identifiers from draft and remembered state', async () => {
        const draft = await renderScreen(<HookProbe
            persistedDraft={{ modelId: 'default', acpSessionModeId: ' plan\t' }}
        />);
        expect(draft.findByTestId('session-mode-id')?.props.children).toBe(' plan\t');

        const remembered = await renderScreen(<HookProbe
            persistedDraft={null}
            rememberedSelection={{
                modelId: null,
                acpSessionModeId: ' ask\t',
                sessionConfigOptionOverrides: null,
                updatedAt: 1,
            }}
        />);
        expect(remembered.findByTestId('session-mode-id')?.props.children).toBe(' ask\t');
    });

    it('seeds model mode, session mode, and config options from remembered engine selection when no draft value exists', async () => {
        const screen = await renderScreen(<HookProbe
            persistedDraft={null}
            rememberedSelection={{
                modelId: 'claude-sonnet-4-6',
                acpSessionModeId: 'plan',
                sessionConfigOptionOverrides: {
                    v: 1,
                    updatedAt: 123,
                    overrides: {
                        reasoning_effort: {
                            updatedAt: 123,
                            value: 'high',
                        },
                    },
                },
                updatedAt: 456,
            }}
        />);

        expect(screen.findByTestId('model-mode')?.props.children).toBe('claude-sonnet-4-6');
        expect(screen.findByTestId('session-mode-id')?.props.children).toBe('plan');
        expect(screen.findByTestId('overrides-json')?.props.children).toContain('"reasoning_effort"');
    });

    it('seeds a remembered dynamic backend model even when the static catalog is stale', async () => {
        const screen = await renderScreen(<HookProbe
            agentType="codex"
            persistedDraft={null}
            rememberedSelection={{
                modelId: 'gpt-5.5',
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
                updatedAt: 456,
            }}
        />);

        expect(screen.findByTestId('model-mode')?.props.children).toBe('gpt-5.5');
    });

    it('keeps persisted draft values ahead of remembered engine selection', async () => {
        const screen = await renderScreen(<HookProbe
            persistedDraft={{
                modelId: 'claude-opus-4-6',
                acpSessionModeId: 'ask',
                sessionConfigOptionOverrides: null,
            }}
            rememberedSelection={{
                modelId: 'claude-sonnet-4-6',
                acpSessionModeId: 'plan',
                sessionConfigOptionOverrides: {
                    v: 1,
                    updatedAt: 123,
                    overrides: {
                        reasoning_effort: {
                            updatedAt: 123,
                            value: 'high',
                        },
                    },
                },
                updatedAt: 456,
            }}
        />);

        expect(screen.findByTestId('model-mode')?.props.children).toBe('claude-opus-4-6');
        expect(screen.findByTestId('session-mode-id')?.props.children).toBe('ask');
        expect(screen.findByTestId('overrides-json')?.props.children).toBe('null');
    });

    it('drops persisted draft model ids that belong to a different backend target', async () => {
        const screen = await renderScreen(<HookProbe
            agentType="codex"
            backendTarget={{ kind: 'builtInAgent', agentId: 'codex' }}
            persistedDraft={{
                agentType: 'claude',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                modelId: 'claude-opus-4-6',
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
            }}
            rememberedSelection={null}
        />);

        expect(screen.findByTestId('model-mode')?.props.children).toBe('default');
    });

    it('does not issue an extra commit when equal session config overrides are re-passed with a fresh object', async () => {
        const commitPhases: string[] = [];
        const persistedDraft: PersistedDraft = {
            modelId: 'default',
            acpSessionModeId: 'default',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 123,
                overrides: {
                    service_tier: {
                        updatedAt: 123,
                        value: 'fast',
                    },
                },
            },
        };

        const screen = await renderScreen(
            <React.Profiler
                id="HookProbe"
                onRender={(_id, phase) => {
                    commitPhases.push(phase);
                }}
            >
                <HookProbe persistedDraft={persistedDraft} />
            </React.Profiler>,
        );

        commitPhases.length = 0;

        await screen.update(
            <React.Profiler
                id="HookProbe"
                onRender={(_id, phase) => {
                    commitPhases.push(phase);
                }}
            >
                <HookProbe
                    persistedDraft={{
                        modelId: 'default',
                        acpSessionModeId: 'default',
                        sessionConfigOptionOverrides: {
                            v: 1,
                            updatedAt: 123,
                            overrides: {
                                service_tier: {
                                    updatedAt: 123,
                                    value: 'fast',
                                },
                            },
                        },
                    }}
                />
            </React.Profiler>,
        );

        expect(commitPhases).toEqual(['update']);
        expect(screen.findByTestId('overrides-json')?.props.children).toContain('"service_tier"');
    });

    it('reconciles changed hydrated config overrides without a passive follow-up commit', async () => {
        const commitPhases: string[] = [];
        const render = (value: string) => (
            <React.Profiler
                id="HookProbe"
                onRender={(_id, phase) => {
                    commitPhases.push(phase);
                }}
            >
                <HookProbe
                    persistedDraft={{
                        modelId: 'default',
                        acpSessionModeId: 'default',
                        sessionConfigOptionOverrides: {
                            v: 1,
                            updatedAt: value === 'fast' ? 123 : 456,
                            overrides: {
                                service_tier: {
                                    updatedAt: value === 'fast' ? 123 : 456,
                                    value,
                                },
                            },
                        },
                    }}
                />
            </React.Profiler>
        );

        const screen = await renderScreen(render('fast'));
        commitPhases.length = 0;

        await screen.update(render('flex'));

        expect(commitPhases).toEqual(['update']);
        expect(screen.findByTestId('overrides-json')?.props.children).toContain('"flex"');
    });

    it('does not rewrite override metadata when the same value is selected again', async () => {
        const nowSpy = vi.spyOn(Date, 'now');
        nowSpy.mockReturnValue(200);

        try {
            const screen = await renderScreen(<HookProbe
                persistedDraft={{
                    modelId: 'default',
                    acpSessionModeId: 'default',
                    sessionConfigOptionOverrides: {
                        v: 1,
                        updatedAt: 100,
                        overrides: {
                            service_tier: {
                                updatedAt: 100,
                                value: 'fast',
                            },
                        },
                    },
                }}
            />);

            const firstJson = screen.findByTestId('overrides-json')?.props.children;

            await act(async () => {
                latestSetSessionConfigOptionOverride?.('service_tier', 'fast');
            });

            const secondJson = screen.findByTestId('overrides-json')?.props.children;

            expect(secondJson).toBe(firstJson);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('persists exact nonblank config identifiers and values without trimming', async () => {
        const screen = await renderScreen(<HookProbe persistedDraft={null} />);

        await act(async () => {
            latestSetSessionConfigOptionOverride?.(' effort ', ' high ');
        });

        expect(JSON.parse(String(screen.findByTestId('overrides-json')?.props.children))).toMatchObject({
            overrides: {
                ' effort ': { value: ' high ' },
            },
        });
    });
});
