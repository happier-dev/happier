import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStackOptionsCapture } from '@/dev/testkit/mocks/router';
import { renderScreen } from '@/dev/testkit';
import { installAutomationAppRouteCommonModuleMocks } from './automationAppRouteTestHelpers';
import {
    AutomationSourceSelectorIdV1Schema,
    AutomationV3DefinitionDetailSchema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
} from '@happier-dev/protocol';
import type { AutomationV3DefinitionDetail } from '@happier-dev/protocol';
import { createAutomationDefinitionFromDetail } from '@/sync/domains/automations/automationDefinitionProjection';
import type { Automation } from '@/sync/domains/automations/automationTypes';
import type { NewSessionData } from '@/utils/sessions/tempDataStore';

type LegacyAutomationFixture = Pick<
    Automation,
    'id' | 'enabled' | 'name' | 'description' | 'targetType' | 'templateCiphertext' | 'schedule'
> & Partial<Pick<Automation, 'templateVersion' | 'nextRunAt' | 'lastRunAt' | 'createdAt' | 'updatedAt'>> & {
    assignments: ReadonlyArray<Readonly<{
        machineId: string;
        enabled: boolean;
        priority: number;
        updatedAt?: number | null;
    }>>;
    projectedExistingSessionId?: string | null;
};

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const updateAutomationSpy = vi.hoisted(() => vi.fn(async () => {}));
const refreshAutomationsSpy = vi.hoisted(() => vi.fn(async () => {}));
const refreshAutomationDefinitionDetailSpy = vi.hoisted(() => vi.fn(async () => {}));
const getSessionEncryptionKeyBase64ForResumeSpy = vi.hoisted(() => vi.fn((_sessionId: string) => null));
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));
const storeTempDataSpy = vi.hoisted(() => vi.fn<(data: NewSessionData) => string>(() => 'temp-edit-seed'));
const updateExistingSessionAutomationTemplateMessageSpy = vi.hoisted(() => vi.fn(async () => 'updated-template'));
const decryptAutomationTemplateRawSpy = vi.hoisted(() => vi.fn(async () => null as unknown));
const modalAlertSpy = vi.hoisted(() => vi.fn());
const tryDecodeAutomationTemplateEnvelopeSpy = vi.hoisted(() => vi.fn((_templateCiphertext: string) => null as any));
const resolveAutomationTemplatePayloadSpy = vi.hoisted(() => vi.fn(async (params: Readonly<{
    templateCiphertext: string;
    decryptRaw?: (payloadCiphertext: string) => Promise<unknown | null>;
}>) => {
    const envelope = tryDecodeAutomationTemplateEnvelopeSpy(params.templateCiphertext);
    if (!envelope) return { kind: 'invalid' as const };
    if (envelope.kind === 'happier_automation_template_plain_v1') {
        return { kind: 'ready' as const, envelope, payload: envelope.payload };
    }
    const payload = params.decryptRaw
        ? await params.decryptRaw(envelope.payloadCiphertext)
        : null;
    return payload === null || payload === undefined
        ? { kind: 'locked' as const, reason: 'encryption_material_unavailable' as const }
        : { kind: 'ready' as const, envelope, payload };
}));
const latestAgentInputProps = vi.hoisted(() => ({
    value: null as any,
}));
const latestContextSectionProps = vi.hoisted(() => ({
    value: null as any,
}));
const latestAutomationSettingsFormProps = vi.hoisted(() => ({
    value: null as any,
}));
const latestUnavailableNoticeProps = vi.hoisted(() => ({
    value: null as any,
}));
const automationState = vi.hoisted(() => ({
    value: ({
        id: 'a1',
        enabled: true,
        name: 'Nightly',
        description: null as string | null,
        targetType: 'new_session' as 'new_session' | 'existing_session',
        templateCiphertext: 'template',
        assignments: [{ machineId: 'machine-1', enabled: true, priority: 100 }],
        schedule: {
            kind: 'interval' as const,
            everyMs: 60_000,
            scheduleExpr: null as string | null,
            timezone: null as string | null,
        },
    } satisfies LegacyAutomationFixture) as LegacyAutomationFixture,
    definitionOverride: null as any,
}));
const sessionState = vi.hoisted(() => ({
    value: null as any,
}));
const getStateSpy = vi.hoisted(() => vi.fn());
const hydrateReadyState = vi.hoisted(() => ({
    ready: true,
}));
const settingsState = vi.hoisted(() => ({
    value: {
        profiles: undefined,
        providerSettingsV1: undefined,
    },
}));
const stackOptionsCapture = createStackOptionsCapture();
const legacyDirectDefinitionCache = new WeakMap<
    LegacyAutomationFixture,
    ReturnType<typeof createAutomationDefinitionFromDetail>
>();

function toLegacyDirectDefinition(automation: LegacyAutomationFixture) {
    const cached = legacyDirectDefinitionCache.get(automation);
    if (cached) return cached;

    const templateVersion = typeof automation.templateVersion === 'number' ? automation.templateVersion : 1;
    const trigger = { kind: 'schedule' as const, schedule: automation.schedule };
    const targetType = automation.targetType === 'existing_session' ? 'existingSession' as const : 'newSession' as const;
    const definition = createAutomationDefinitionFromDetail(AutomationV3DefinitionDetailSchema.parse({
        id: automation.id,
        name: automation.name,
        description: automation.description,
        enabled: automation.enabled,
        trigger,
        targetType,
        templateVersion,
        nextRunAt: automation.nextRunAt ?? null,
        lastRunAt: automation.lastRunAt ?? null,
        createdAt: automation.createdAt ?? 1,
        updatedAt: automation.updatedAt ?? 1,
        assignments: automation.assignments.map((assignment) => ({
            ...assignment,
            updatedAt: assignment.updatedAt ?? 0,
        })),
        templateCiphertext: automation.templateCiphertext,
        triggerDefinitionEnvelope: null,
    }));
    const directDefinition = {
        ...definition,
        linkedExistingSessionId: automation.projectedExistingSessionId ?? definition.linkedExistingSessionId,
    };
    legacyDirectDefinitionCache.set(automation, directDefinition);
    return directDefinition;
}

function directEventDefinition(params: Readonly<{
    assignments?: ReadonlyArray<Readonly<{
        machineId: string;
        enabled: boolean;
        priority: number;
        updatedAt: number | null;
    }>>;
}> = {}) {
    const templateVersion = 7;
    const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse('11111111-1111-4111-8111-111111111111');
    const detail = AutomationV3DefinitionDetailSchema.parse({
        id: 'a1',
        name: 'Repository triage',
        description: 'Review repository activity',
        enabled: true,
        trigger: {
            kind: 'pluginEvent',
            eventRef: { pluginId: 'acme.github', localId: 'repository-updated' },
            sourceSelectorId,
            sourceContractVersion: 3,
            observation: {
                kind: 'checkpointedPull',
                watcher: {
                    machineId: 'watcher-machine',
                    machineInstallationId: 'watcher-installation',
                    pluginId: 'acme.github',
                    materializationId: 'github-materialization',
                },
            },
        },
        targetType: 'newSession',
        templateVersion,
        nextRunAt: null,
        lastRunAt: null,
        createdAt: 1,
        updatedAt: 2,
        assignments: params.assignments ?? [{ machineId: 'executor-machine', enabled: true, priority: 100, updatedAt: null }],
        triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: 'plain',
            binding: {
                v: 1,
                automationId: 'a1',
                templateVersion,
                triggerKind: 'pluginEvent',
                eventRef: { pluginId: 'acme.github', localId: 'repository-updated' },
                sourceSelectorId,
            },
            definition: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceConfig: { repository: 'acme/widgets' },
                displayLabel: 'acme/widgets',
                filter: null,
                maximumObservationAgeMs: 60_000,
            },
        })),
        executionRecipe: {
            v: 1,
            templateVersion,
            template: { t: 'plain', v: { v: 1, prompt: 'Review {{input}}' } },
            triggerEvidence: null,
            target: {
                kind: 'newSession',
                spawn: {
                    executionTarget: { serverId: 'server-1', machineId: 'executor-machine' },
                    directory: '/workspace/acme',
                    organizationPlacement: { folderId: null, tagIds: [] },
                    agentTarget: {
                        kind: 'agent',
                        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                    },
                    permissionMode: 'default',
                    configuration: {
                        mode: { value: null, updatedAtMs: 1 },
                        model: { value: null, updatedAtMs: 1 },
                        permissionIntent: { value: 'default', updatedAtMs: 1 },
                        options: {},
                    },
                },
            },
        },
    });
    const {
        triggerDefinitionEnvelope: _triggerDefinitionEnvelope,
        executionRecipe: _executionRecipe,
        templateCiphertext: _templateCiphertext,
        ...summary
    } = detail;
    return {
        ...summary,
        detail: { kind: 'available' as const, templateVersion, value: detail },
        linkedExistingSessionId: null,
    };
}

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => React.createElement('ItemList', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: any) => {
        latestAgentInputProps.value = props;
        return React.createElement('AgentInput', props);
    },
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
    useLayoutMaxWidth: () => 1000,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 1000 }),
}));

vi.mock('@/components/automations/gating/AutomationsGate', () => ({
    AutomationsGate: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/automations/editor/AutomationSettingsForm', () => ({
    AutomationSettingsForm: (props: any) => {
        latestAutomationSettingsFormProps.value = props;
        return React.createElement('AutomationSettingsForm', props);
    },
}));

vi.mock('@/components/automations/shared/ExistingSessionAutomationContextSection', () => ({
    ExistingSessionAutomationContextSection: (props: any) => {
        latestContextSectionProps.value = props;
        return React.createElement('ExistingSessionAutomationContextSection', props);
    },
}));

vi.mock('@/components/automations/shared/ExistingSessionAutomationUnavailableNotice', () => ({
    ExistingSessionAutomationUnavailableNotice: (props: any) => {
        latestUnavailableNoticeProps.value = props;
        return React.createElement('ExistingSessionAutomationUnavailableNotice', props);
    },
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => hydrateReadyState.ready
        ? { kind: 'available', sessionId }
        : { kind: 'loading', sessionId, reason: 'store-miss' },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        updateAutomation: updateAutomationSpy,
        refreshAutomations: refreshAutomationsSpy,
        refreshAutomationDefinitionDetail: refreshAutomationDefinitionDetailSpy,
        getSessionEncryptionKeyBase64ForResume: getSessionEncryptionKeyBase64ForResumeSpy,
        encryption: {
            decryptAutomationTemplateRaw: decryptAutomationTemplateRawSpy,
        },
    },
}));

vi.mock('@/sync/domains/automations/automationExistingSessionTemplateUpdate', () => ({
    updateExistingSessionAutomationTemplateMessage: updateExistingSessionAutomationTemplateMessageSpy,
}));

vi.mock('@/sync/domains/automations/automationTemplateTransport', () => ({
    tryDecodeAutomationTemplateEnvelope: tryDecodeAutomationTemplateEnvelopeSpy,
    resolveAutomationTemplatePayload: resolveAutomationTemplatePayloadSpy,
}));

vi.mock('@/sync/domains/automations/automationTemplateCodec', () => ({
    decodeAutomationTemplate: vi.fn(() => null),
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    storeTempData: storeTempDataSpy,
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => promise,
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));

installAutomationAppRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { back: routerBackSpy, replace: routerReplaceSpy },
            params: { id: 'a1' },
            stackOptionsCapture,
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        const readSnapshot = () => getStateSpy();
        return createStorageModuleStub({
            useAutomation: () => automationState.definitionOverride ?? toLegacyDirectDefinition(automationState.value),
            useSession: () => sessionState.value,
            useSettings: () => settingsState.value,
            storage: Object.assign(
                ((selector?: (value: ReturnType<typeof readSnapshot>) => unknown) => {
                    const snapshot = readSnapshot();
                    return typeof selector === 'function' ? selector(snapshot) : snapshot;
                }),
                {
                    getState: readSnapshot,
                    getInitialState: readSnapshot,
                    setState: () => undefined,
                    subscribe: () => () => undefined,
                    destroy: () => undefined,
                },
            ),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => {
            const labels: Record<string, string> = {
                'automations.edit.title': 'Edit automation',
                'automations.edit.saveAutomationLabel': 'Save automation',
                'settingsAccount.restoreRequiredTitle': 'Restore required',
                'settingsAccount.secretKeyMissing': 'Secret key unavailable. Please restore your account first.',
                'common.back': 'Back',
            };
            return labels[key] ?? key;
        } });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alert: modalAlertSpy } }).module;
    },
});

describe('AutomationEditScreen route', () => {
    beforeEach(() => {
        hydrateReadyState.ready = true;
        stackOptionsCapture.reset();
        routerBackSpy.mockReset();
        routerReplaceSpy.mockReset();
        updateAutomationSpy.mockClear();
        refreshAutomationsSpy.mockClear();
        refreshAutomationDefinitionDetailSpy.mockClear();
        getSessionEncryptionKeyBase64ForResumeSpy.mockClear();
        navigateWithBlurOnWebSpy.mockClear();
        storeTempDataSpy.mockClear();
        updateExistingSessionAutomationTemplateMessageSpy.mockClear();
        decryptAutomationTemplateRawSpy.mockReset();
        decryptAutomationTemplateRawSpy.mockResolvedValue(null);
        modalAlertSpy.mockClear();
        tryDecodeAutomationTemplateEnvelopeSpy.mockReset();
        tryDecodeAutomationTemplateEnvelopeSpy.mockReturnValue(null);
        resolveAutomationTemplatePayloadSpy.mockClear();
        latestAgentInputProps.value = null;
        latestContextSectionProps.value = null;
        latestAutomationSettingsFormProps.value = null;
        latestUnavailableNoticeProps.value = null;
        automationState.definitionOverride = null;
        automationState.value = {
            id: 'a1',
            enabled: true,
            name: 'Nightly',
            description: null,
            targetType: 'new_session',
            templateCiphertext: 'template',
            assignments: [{ machineId: 'machine-1', enabled: true, priority: 100 }],
            schedule: {
                kind: 'interval',
                everyMs: 60_000,
                scheduleExpr: null,
                timezone: null,
            },
        };
        sessionState.value = null;
        getStateSpy.mockImplementation(() => ({
            sessions: sessionState.value ? {
                s1: sessionState.value,
                'session-1': sessionState.value,
            } : {},
            machines: {
                'machine-1': {
                    id: 'machine-1',
                    active: true,
                    metadata: {},
                },
                m1: {
                    id: 'm1',
                    active: true,
                    metadata: {},
                },
                'm-target': {
                    id: 'm-target',
                    active: true,
                    metadata: {},
                },
                'm-stale': {
                    id: 'm-stale',
                    active: true,
                    metadata: {},
                },
            },
            getProjectForSession: () => null,
        }));
    });

    const settle = async () => {
        await flushHookEffects({ cycles: 1, turns: 1 });
    };

    it('loads direct V3 detail before admitting the retained schedule editor', async () => {
        automationState.definitionOverride = {
            id: 'a1',
            name: 'Nightly',
            description: null,
            enabled: true,
            trigger: {
                kind: 'schedule',
                schedule: {
                    kind: 'interval',
                    everyMs: 60_000,
                    scheduleExpr: null,
                    timezone: null,
                },
            },
            targetType: 'newSession',
            templateVersion: 2,
            nextRunAt: null,
            lastRunAt: null,
            createdAt: 1,
            updatedAt: 1,
            assignments: [],
            detail: { kind: 'unloaded', templateVersion: 2 },
            linkedExistingSessionId: null,
        };
        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));
        await settle();

        expect(refreshAutomationDefinitionDetailSpy).toHaveBeenCalledWith('a1');
        expect(storeTempDataSpy).not.toHaveBeenCalled();
    });

    it('redirects new-session automations into the shared new-session composer with hydrated temp data', async () => {
        const transport = await import('@/sync/domains/automations/automationTemplateTransport');
        const codec = await import('@/sync/domains/automations/automationTemplateCodec');
        vi.mocked(transport.tryDecodeAutomationTemplateEnvelope).mockReturnValue({
            kind: 'happier_automation_template_plain_v1',
            payload: { prompt: 'Run nightly checks' },
        } as any);
        vi.mocked(codec.decodeAutomationTemplate).mockReturnValue({
            directory: '/repo/project',
            prompt: 'Run nightly checks',
            displayText: 'Run nightly checks',
            agent: 'codex',
            profileId: 'profile-1',
            transcriptStorage: 'direct',
            permissionMode: 'acceptEdits',
            modelId: 'gpt-5',
        } as any);

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));
        await settle();

        expect(storeTempDataSpy).toHaveBeenCalledWith(expect.objectContaining({
            prompt: 'Run nightly checks',
            machineId: 'machine-1',
            directory: '/repo/project',
            selectedProfileId: 'profile-1',
            transcriptStorage: 'direct',
            permissionMode: 'acceptEdits',
            modelSelection: {
                v: 1,
                updatedAt: 0,
                ref: {
                    agentTargetKey: 'backend:codex',
                    providerConnectionId: null,
                    modelId: 'gpt-5',
                },
            },
            automationDraft: expect.objectContaining({
                enabled: true,
                name: 'Nightly',
                scheduleKind: 'interval',
                everyMinutes: 1,
            }),
        }));
        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceSpy).toHaveBeenCalledWith('/new?automation=1&automationEditId=a1&dataId=temp-edit-seed');
    });

    it('redirects a plain direct Event definition into the same composer without collapsing its assignment topology into editable state', async () => {
        automationState.definitionOverride = directEventDefinition({
            assignments: [
                { machineId: 'executor-primary', enabled: true, priority: 400, updatedAt: 12 },
                { machineId: 'executor-disabled', enabled: false, priority: 17, updatedAt: 13 },
                { machineId: 'executor-fallback', enabled: true, priority: 3, updatedAt: null },
            ],
        });
        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));
        await settle();

        const tempData = storeTempDataSpy.mock.calls.at(-1)?.[0];
        expect(tempData).toEqual(expect.objectContaining({
            prompt: 'Review {{input}}',
            machineId: 'executor-machine',
            directory: '/workspace/acme',
            automationDraft: expect.objectContaining({
                enabled: true,
                name: 'Repository triage',
                description: 'Review repository activity',
            }),
            eventAutomationEditSeed: expect.objectContaining({
                automationId: 'a1',
                expectedTemplateVersion: 7,
                eventRef: { pluginId: 'acme.github', localId: 'repository-updated' },
                source: expect.objectContaining({
                    sourceInstanceId: 'repository:42',
                    sourceContractVersion: 3,
                }),
                watcherMaterializationRef: expect.objectContaining({
                    machineId: 'watcher-machine',
                    materializationId: 'github-materialization',
                }),
            }),
        }));
        // Placement is not editable on this route. Keeping the direct-detail
        // assignment collection out of the temp seed leaves the writer's
        // immediately re-read current detail as its sole authority.
        expect(tempData?.eventAutomationEditSeed).not.toHaveProperty('assignments');
        expect(routerReplaceSpy).toHaveBeenCalledWith('/new?automation=1&automationEditId=a1&dataId=temp-edit-seed');
    });

    it('renders the shared unavailable notice for blocked existing-session automations', async () => {
        const transport = await import('@/sync/domains/automations/automationTemplateTransport');
        const codec = await import('@/sync/domains/automations/automationTemplateCodec');
        automationState.value = {
            id: 'a1',
            enabled: true,
            name: 'Nightly',
            description: null,
            targetType: 'existing_session',
            templateCiphertext: 'template',
            projectedExistingSessionId: 's1',
            assignments: [{ machineId: 'machine-1', enabled: true, priority: 100 }],
            schedule: {
                kind: 'interval',
                everyMs: 60_000,
                scheduleExpr: null,
                timezone: null,
            },
        } as any;
        sessionState.value = {
            id: 's1',
            active: true,
            encryptionMode: 'e2ee',
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };
        getSessionEncryptionKeyBase64ForResumeSpy.mockReturnValueOnce(null);
        vi.mocked(transport.tryDecodeAutomationTemplateEnvelope).mockReturnValue({
            kind: 'happier_automation_template_plain_v1',
            existingSessionId: 's1',
            payload: { existingSessionId: 's1', directory: '/tmp/project', prompt: 'Send summary', displayText: 'Send summary' },
        } as any);
        vi.mocked(codec.decodeAutomationTemplate).mockReturnValue({
            existingSessionId: 's1',
            directory: '/tmp/project',
            prompt: 'Send summary',
            displayText: 'Send summary',
        } as any);

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));
        await settle();

        expect(latestUnavailableNoticeProps.value).toEqual(expect.objectContaining({
            reason: 'session.inactiveNotResumableNoticeTitle',
        }));
        expect(latestAutomationSettingsFormProps.value).toBeNull();
        expect(latestContextSectionProps.value).toBeNull();
        expect(latestAgentInputProps.value).toBeNull();
    });

    it('hydrates the shared composer from the sync-projected encrypted existing-session association', async () => {
        const transport = await import('@/sync/domains/automations/automationTemplateTransport');
        const codec = await import('@/sync/domains/automations/automationTemplateCodec');
        automationState.value = {
            ...automationState.value,
            targetType: 'existing_session',
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_encrypted_v1',
                payloadCiphertext: 'template-ciphertext',
            }),
            projectedExistingSessionId: 'session-1',
        };
        sessionState.value = {
            id: 'session-1',
            active: true,
            encryptionMode: 'plain',
            permissionMode: 'default',
            permissionModeUpdatedAt: 999,
            modelMode: 'default',
            modelModeUpdatedAt: 111,
            metadata: {
                machineId: 'm-target',
                path: '/repo/project',
                homeDir: '/repo',
                flavor: 'acp:review-bot',
            },
        };
        getStateSpy.mockImplementation(() => ({
            sessions: {
                'session-1': sessionState.value,
            },
            machines: {
                'm-target': {
                    id: 'm-target',
                    active: true,
                    activeAt: 10,
                    metadata: { host: 'mbp-host' },
                },
            },
            getProjectForSession: (sessionId: string) => sessionId === 'session-1'
                ? {
                    key: {
                        machineId: 'm-target',
                        path: '/repo/project',
                    },
                }
                : null,
        }));
        decryptAutomationTemplateRawSpy.mockResolvedValue({
            directory: '/repo/project',
            existingSessionId: 'session-1',
            prompt: 'Resume the review',
            displayText: 'Resume the review',
        });
        vi.mocked(transport.tryDecodeAutomationTemplateEnvelope).mockReturnValue({
            kind: 'happier_automation_template_encrypted_v1',
            payloadCiphertext: 'template-ciphertext',
        } as any);
        vi.mocked(codec.decodeAutomationTemplate).mockReturnValue({
            existingSessionId: 'session-1',
            directory: '/repo/project',
            prompt: 'Resume the review',
            displayText: 'Resume the review',
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            permissionMode: 'read-only',
            permissionModeUpdatedAt: 12,
            modelId: 'claude-sonnet-4-6',
            modelUpdatedAt: 34,
        } as any);

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;
        await renderScreen(React.createElement(EditRoute));
        await settle();

        expect(latestAgentInputProps.value).toEqual(expect.objectContaining({
            sessionId: 'session-1',
            currentPath: '/repo/project',
            permissionMode: 'read-only',
            modelMode: 'claude-sonnet-4-6',
        }));
        expect(getSessionEncryptionKeyBase64ForResumeSpy).toHaveBeenCalledWith('session-1');
    });

    it('preserves configured ACP backend targets when redirecting new-session automations into the shared composer', async () => {
        const transport = await import('@/sync/domains/automations/automationTemplateTransport');
        const codec = await import('@/sync/domains/automations/automationTemplateCodec');
        vi.mocked(transport.tryDecodeAutomationTemplateEnvelope).mockReturnValue({
            kind: 'happier_automation_template_plain_v1',
            payload: { prompt: 'Run nightly checks' },
        } as any);
        vi.mocked(codec.decodeAutomationTemplate).mockReturnValue({
            directory: '/repo/project',
            prompt: 'Run nightly checks',
            displayText: 'Run nightly checks',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            transcriptStorage: 'direct',
            permissionMode: 'acceptEdits',
            modelId: 'gpt-5',
        } as any);

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));
        await settle();

        expect(storeTempDataSpy).toHaveBeenCalledWith(expect.objectContaining({
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
        }));
    });

    it('reports a retained encrypted automation as locked instead of treating it as invalid or empty', async () => {
        const transport = await import('@/sync/domains/automations/automationTemplateTransport');
        vi.mocked(transport.tryDecodeAutomationTemplateEnvelope).mockReturnValue({
            kind: 'happier_automation_template_encrypted_v1',
            payloadCiphertext: 'retained-ciphertext',
        } as any);

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;
        await renderScreen(React.createElement(EditRoute));
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(modalAlertSpy).toHaveBeenCalledWith(
            'Restore required',
            'Secret key unavailable. Please restore your account first.',
        );
        expect(storeTempDataSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('waits for existing-session deep-link hydration before showing the session-not-found state', async () => {
        hydrateReadyState.ready = false;
        automationState.value = {
            id: 'a1',
            enabled: true,
            name: 'Nightly',
            description: null,
            targetType: 'existing_session',
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_plain_v1',
                payload: {
                    directory: '/tmp/project',
                    prompt: 'Follow up',
                    displayText: 'Follow up',
                    existingSessionId: 's1',
                },
            }),
            projectedExistingSessionId: 's1',
            assignments: [{ machineId: 'machine-1', enabled: true, priority: 100 }],
            schedule: {
                kind: 'interval',
                everyMs: 60_000,
                scheduleExpr: null,
                timezone: null,
            },
        };
        sessionState.value = null;

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));
        await settle();

        expect(latestAutomationSettingsFormProps.value).toBeNull();
        expect(latestContextSectionProps.value).toBeNull();
        expect(latestAgentInputProps.value).toBeNull();
        expect(latestUnavailableNoticeProps.value).toBeNull();
    });

    it('replaces to the automation detail route after save', async () => {
        const transport = await import('@/sync/domains/automations/automationTemplateTransport');
        const codec = await import('@/sync/domains/automations/automationTemplateCodec');
        vi.mocked(transport.tryDecodeAutomationTemplateEnvelope).mockReturnValue({
            kind: 'happier_automation_template_plain_v1',
            payload: { prompt: 'Follow up', displayText: 'Follow up', existingSessionId: 's1' },
            existingSessionId: 's1',
        } as any);
        vi.mocked(codec.decodeAutomationTemplate).mockReturnValue({
            directory: '/tmp/project',
            prompt: 'Follow up',
            displayText: 'Follow up',
            existingSessionId: 's1',
        } as any);
        automationState.value = {
            id: 'a1',
            enabled: true,
            name: 'Nightly',
            description: null,
            targetType: 'existing_session',
            templateCiphertext: 'template',
            projectedExistingSessionId: 's1',
            assignments: [{ machineId: 'machine-1', enabled: true, priority: 100 }],
            schedule: {
                kind: 'interval',
                everyMs: 60_000,
                scheduleExpr: null,
                timezone: null,
            },
        };
        sessionState.value = {
            id: 's1',
            encryptionMode: 'plain',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelMode: 'gpt-5',
            modelModeUpdatedAt: 456,
            metadata: {
                machineId: 'machine-1',
                path: '/tmp/project',
                homeDir: '/tmp',
                profileId: 'profile-1',
                flavor: 'codex',
                codexSessionId: 'codex-session-1',
                codexBackendMode: 'acp',
                acpConfiguredBackendV1: {
                    v: 1,
                    updatedAt: 20,
                    backendId: 'review-bot',
                    title: 'Review Bot',
                },
            },
        } as any;

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));
        await settle();

        const composer = latestAgentInputProps.value;
        await act(async () => {
            composer.onChangeText('Follow up with the latest review summary');
            composer.onPermissionModeChange?.('acceptEdits');
            composer.onModelModeChange?.('gpt-5');
            await composer.onSend();
        });

        expect(updateAutomationSpy).toHaveBeenCalledWith('a1', expect.objectContaining({
            enabled: true,
            name: 'Nightly',
        }));
        expect(updateExistingSessionAutomationTemplateMessageSpy).toHaveBeenCalledWith(expect.objectContaining({
            draft: expect.objectContaining({
                prompt: 'Follow up with the latest review summary',
                displayText: 'Follow up with the latest review summary',
                permissionMode: 'acceptEdits',
                modelSelection: expect.objectContaining({
                    ref: expect.objectContaining({
                        agentTargetKey: 'backend:review-bot:configured:review-bot',
                        modelId: 'gpt-5',
                    }),
                }),
                existingSessionId: 's1',
            }),
            fallbackDraft: expect.objectContaining({
                backendTarget: expect.objectContaining({
                    kind: 'backend',
                    backendId: 'review-bot',
                    configuredBackendId: 'review-bot',
                }),
                profileId: 'profile-1',
                permissionMode: 'safe-yolo',
                permissionModeUpdatedAt: 123,
                modelSelection: {
                    v: 1,
                    updatedAt: 456,
                    ref: {
                        agentTargetKey: 'backend:review-bot:configured:review-bot',
                        providerConnectionId: null,
                        modelId: 'gpt-5',
                    },
                },
                codexBackendMode: 'acp',
                automation: null,
                existingSessionId: 's1',
            }),
        }));
        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceSpy).toHaveBeenCalledWith('/automations/a1');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('routes the existing-session save action through the shared composer only', async () => {
        const transport = await import('@/sync/domains/automations/automationTemplateTransport');
        const codec = await import('@/sync/domains/automations/automationTemplateCodec');
        vi.mocked(transport.tryDecodeAutomationTemplateEnvelope).mockReturnValue({
            kind: 'happier_automation_template_plain_v1',
            payload: { prompt: 'Follow up', displayText: 'Follow up', existingSessionId: 's1' },
            existingSessionId: 's1',
        } as any);
        vi.mocked(codec.decodeAutomationTemplate).mockReturnValue({
            directory: '/tmp/project',
            prompt: 'Follow up',
            displayText: 'Follow up',
            existingSessionId: 's1',
        } as any);
        automationState.value = {
            id: 'a1',
            enabled: true,
            name: 'Nightly',
            description: null,
            targetType: 'existing_session',
            templateCiphertext: 'template',
            projectedExistingSessionId: 's1',
            assignments: [{ machineId: 'machine-1', enabled: true, priority: 100 }],
            schedule: {
                kind: 'interval',
                everyMs: 60_000,
                scheduleExpr: null,
                timezone: null,
            },
        };
        sessionState.value = {
            id: 's1',
            encryptionMode: 'plain',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelMode: 'gpt-5',
            modelModeUpdatedAt: 456,
            metadata: {
                machineId: 'machine-1',
                path: '/tmp/project',
                homeDir: '/tmp',
                profileId: 'profile-1',
                flavor: 'codex',
                codexSessionId: 'codex-session-1',
                codexBackendMode: 'acp',
                acpConfiguredBackendV1: {
                    v: 1,
                    updatedAt: 20,
                    backendId: 'review-bot',
                    title: 'Review Bot',
                },
            },
        } as any;

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));
        await settle();

        expect(latestAutomationSettingsFormProps.value).toBeNull();
        expect(latestAgentInputProps.value).toEqual(expect.objectContaining({
            submitAccessibilityLabel: 'Save automation',
        }));
    });

    it('replaces to the automation detail route from the header back action', async () => {
        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));

        navigateWithBlurOnWebSpy.mockClear();
        routerReplaceSpy.mockClear();
        routerBackSpy.mockClear();

        const options = stackOptionsCapture.getResolved();
        expect(typeof options?.headerLeft).toBe('function');

        const headerLeft = options?.headerLeft as (() => React.ReactElement<{
            accessibilityLabel?: string;
            onPress?: () => void;
        }> | null) | undefined;
        const backButton = headerLeft?.();
        expect(backButton?.props.accessibilityLabel).toBe('Back');
        await act(async () => {
            backButton?.props.onPress?.();
        });

        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceSpy).toHaveBeenCalledWith('/automations/a1');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('does not save an existing-session automation when the target session is not resumable', async () => {
        const transport = await import('@/sync/domains/automations/automationTemplateTransport');
        const codec = await import('@/sync/domains/automations/automationTemplateCodec');
        vi.mocked(transport.tryDecodeAutomationTemplateEnvelope).mockReturnValue({
            kind: 'happier_automation_template_plain_v1',
            payload: { prompt: 'Follow up', displayText: 'Follow up', existingSessionId: 's1' },
            existingSessionId: 's1',
        } as any);
        vi.mocked(codec.decodeAutomationTemplate).mockReturnValue({
            directory: '/tmp/project',
            prompt: 'Follow up',
            displayText: 'Follow up',
            existingSessionId: 's1',
        } as any);
        automationState.value = {
            id: 'a1',
            enabled: true,
            name: 'Nightly',
            description: null,
            targetType: 'existing_session',
            templateCiphertext: 'template',
            projectedExistingSessionId: 's1',
            assignments: [{ machineId: 'machine-1', enabled: true, priority: 100 }],
            schedule: {
                kind: 'interval',
                everyMs: 60_000,
                scheduleExpr: null,
                timezone: null,
            },
        };
        sessionState.value = {
            id: 's1',
            active: true,
            metadata: {
                machineId: 'm1',
                flavor: 'pi',
                piSessionId: 'pi-session-1',
            },
        };

        const EditRoute = (await import('@/app/(app)/automations/edit')).default;

        await renderScreen(React.createElement(EditRoute));
        await settle();

        expect(latestAgentInputProps.value).toBeNull();
        expect(updateAutomationSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });
});
