import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderConnectionIdSchema, ProviderLocalIdSchema } from '@happier-dev/protocol/providers/ids';
import { ProviderConnectionSecurityFingerprintV1Schema} from '@happier-dev/protocol/providers/fingerprints';

import { renderHook, standardCleanup } from '@/dev/testkit';

import type { TeamCredentialResourceDraft } from './teamCredentialEditorDraft';

const preventRemoveState = vi.hoisted(() => ({ enabled: false }));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock({
        usePreventRemove: (enabled) => {
            preventRemoveState.enabled = enabled;
        },
    });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

afterEach(standardCleanup);

describe('normalized Team delivery draft', () => {
    it('keeps native grants independent of the existing broker/direct presentation choices', async () => {
        const { offeredDeliveryModes, teamCredentialAudienceRoutesForMode } = await import('./teamCredentialEditorDraft');
        expect(offeredDeliveryModes({ deliveryPolicy: { preferredAllowedModes: ['vendor-native'] } })).toEqual([]);
        expect(offeredDeliveryModes({ deliveryPolicy: { preferredAllowedModes: ['direct'] }, directExportSupport: 'supported' })).toEqual(['direct']);
        expect(teamCredentialAudienceRoutesForMode('both', null)).toEqual(['brokered', 'direct']);
        expect(teamCredentialAudienceRoutesForMode('brokered', ['vendor-native', 'direct'])).toEqual(['vendor-native', 'brokered']);
        expect(teamCredentialAudienceRoutesForMode('both', ['vendor-native', 'brokered'])).toEqual(['vendor-native', 'brokered', 'direct']);
    });

    it('defaults new resources to broker-only permission and retains preference order in dirty state', async () => {
        const { EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT, teamCredentialResourceDraftFingerprint } = await import('./teamCredentialEditorDraft');
        expect(EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT.deliveryPolicy).toEqual({ preferredAllowedModes: ['brokered'] });
        const nativeFirst = { ...EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT,
            deliveryPolicy: { preferredAllowedModes: ['vendor-native', 'brokered'] as const } };
        const brokerFirst = { ...nativeFirst, deliveryPolicy: { preferredAllowedModes: ['brokered', 'vendor-native'] as const } };
        expect(teamCredentialResourceDraftFingerprint(nativeFirst)).not.toBe(teamCredentialResourceDraftFingerprint(brokerFirst));
    });
});

describe('reconcileTeamCredentialPolicyDraftForModelCatalog', () => {
    it('preserves policy when support is unknown and identifies only positively unsupported models', async () => {
        const { reconcileTeamCredentialPolicyDraftForModelCatalog } = await import('./teamCredentialEditorDraft');
        const draft = {
            protocols: ['openai_responses'] as const,
            allowedModelIds: ['shared', 'old'],
            reasoningEffort: { allowedValues: ['low', 'high'], defaultValue: 'high' },
        };

        expect(reconcileTeamCredentialPolicyDraftForModelCatalog(draft, null)).toEqual({
            draft,
            invalidatedModelIds: [],
        });
        expect(reconcileTeamCredentialPolicyDraftForModelCatalog(draft, ['shared'])).toEqual({
            draft: { ...draft, allowedModelIds: ['shared'] },
            invalidatedModelIds: ['old'],
        });
    });
});

describe('teamCredentialUsageLimitDeltaFromDraft', () => {
    it('upserts only changed/new rows and deletes only loaded rows removed from the draft', async () => {
        const { teamCredentialUsageLimitDeltaFromDraft } = await import('./teamCredentialEditorDraft');
        const unchanged = { id: 'limit-a', subjectKind: 'resource' as const, subjectId: '', metric: 'inference_requests' as const, period: 'month' as const, maximum: '10', enabled: true };
        const changed = { id: 'limit-b', subjectKind: 'each_member' as const, subjectId: '', metric: 'total_tokens' as const, period: 'week' as const, maximum: '20', enabled: true };
        const removed = { id: 'limit-c', subjectKind: 'resource' as const, subjectId: '', metric: 'inference_requests' as const, period: 'day' as const, maximum: '5', enabled: true };
        const added = { subjectKind: 'resource' as const, subjectId: '', metric: 'cost_usd' as const, period: 'month' as const, maximum: ' 3.50 ', enabled: true };

        expect(teamCredentialUsageLimitDeltaFromDraft([
            unchanged,
            { ...changed, maximum: '25' },
            added,
        ], [unchanged, changed, removed])).toEqual({
            upserts: [{ ...changed, maximum: '25' }, { ...added, maximum: '3.50' }],
            deleteIds: ['limit-c'],
        });
    });

    it('retains invalid raw values instead of constructing a lossy mutation', async () => {
        const { teamCredentialUsageLimitDeltaFromDraft } = await import('./teamCredentialEditorDraft');
        expect(teamCredentialUsageLimitDeltaFromDraft([{
            subjectKind: 'resource', subjectId: '', metric: 'inference_requests', period: 'month', maximum: '1.5', enabled: true,
        }], [])).toBe('invalid');
    });
});

describe('useTeamCredentialResourceDraft', () => {
    it('preserves one create/edit draft across validation and conflict rerenders, but resets it at a new scoped target', async () => {
        const { useTeamCredentialResourceDraft } = await import('./teamCredentialEditorDraft');
        const hook = await renderHook(
            ({ targetKey, initial }: Readonly<{ targetKey: string; initial: TeamCredentialResourceDraft }>) =>
                useTeamCredentialResourceDraft({ targetKey, initial }),
            {
                initialProps: {
                    targetKey: 'home-a:account-a:team-a:resource-a',
                    initial: {
                        name: 'Saved',
                        source: null,
                        deliveryPolicy: { preferredAllowedModes: ['brokered'] },
                        brokerPlacement: null,
                        sessionUsePolicy: 'personal_allowed',
                        audience: { allMembers: null, groups: new Map(), members: new Map() },
                        requestPolicy: {
                            protocols: null,
                            allowedModelIds: null,
                            reasoningEffort: null,
                        },
                        limits: [],
                        pendingLimit: {
                            subjectKind: 'resource', subjectId: '', metric: 'inference_requests',
                            period: 'month', maximum: '', enabled: true,
                        },
                    },
                },
            },
        );

        act(() => hook.getCurrent().setDraft((current) => ({ ...current, name: 'Unsaved' })));
        expect(hook.getCurrent().draft.name).toBe('Unsaved');
        expect(hook.getCurrent().isDirty).toBe(true);

        await hook.rerender({
            targetKey: 'home-a:account-a:team-a:resource-a',
            initial: {
                name: 'Server moved',
                source: null,
                deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] },
                brokerPlacement: { kind: 'machine', machineId: 'new-machine' },
                sessionUsePolicy: 'team_context_required',
                audience: { allMembers: null, groups: new Map(), members: new Map() },
                requestPolicy: {
                    protocols: null,
                    allowedModelIds: null,
                    reasoningEffort: null,
                },
                limits: [],
                pendingLimit: {
                    subjectKind: 'resource', subjectId: '', metric: 'inference_requests',
                    period: 'month', maximum: '', enabled: true,
                },
            },
        });
        expect(hook.getCurrent().draft.name).toBe('Unsaved');

        await hook.rerender({
            targetKey: 'home-b:account-a:team-b:resource-a',
            initial: {
                name: 'Other target',
                source: null,
                deliveryPolicy: { preferredAllowedModes: ['brokered'] },
                brokerPlacement: null,
                sessionUsePolicy: 'personal_allowed',
                audience: { allMembers: null, groups: new Map(), members: new Map() },
                requestPolicy: {
                    protocols: null,
                    allowedModelIds: null,
                    reasoningEffort: null,
                },
                limits: [],
                pendingLimit: {
                    subjectKind: 'resource', subjectId: '', metric: 'inference_requests',
                    period: 'month', maximum: '', enabled: true,
                },
            },
        });
        expect(hook.getCurrent().draft.name).toBe('Other target');
        expect(hook.getCurrent().isDirty).toBe(false);
    });

    it('requires review when a native-only resource changes source, even before granting an audience', async () => {
        const { EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT, useTeamCredentialResourceDraft } = await import('./teamCredentialEditorDraft');
        const initial: TeamCredentialResourceDraft = {
            ...EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT,
            source: {
                v: 1, kind: 'provider_connection',
                connectionId: ProviderConnectionIdSchema.parse('connection-a'),
                connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema.parse('connection-security:v1:source-a'),
                credentialSlotId: ProviderLocalIdSchema.parse('apiKey'),
            },
            deliveryPolicy: { preferredAllowedModes: ['vendor-native', 'brokered'] },
        };
        const hook = await renderHook(() => useTeamCredentialResourceDraft({ targetKey: 'home:account:team:resource', initial }));
        expect(hook.getCurrent().disclosureAccepted).toBe(true);
        expect(hook.getCurrent().disclosureReviewCompleted).toBe(true);
        act(() => hook.getCurrent().setDraft(current => ({ ...current,
            source: current.source?.kind === 'provider_connection'
                ? { ...current.source, connectionId: ProviderConnectionIdSchema.parse('connection-b') }
                : current.source,
        })));
        expect(hook.getCurrent().disclosureAccepted).toBe(false);
        expect(hook.getCurrent().disclosureReviewCompleted).toBe(false);
        act(() => hook.getCurrent().acceptDisclosure());
        act(() => hook.getCurrent().setDraft(current => ({ ...current,
            name: 'Renamed', deliveryPolicy: { preferredAllowedModes: ['brokered', 'vendor-native'] },
        })));
        expect(hook.getCurrent().disclosureAccepted).toBe(true);
    });

    it('keys disclosure acknowledgement to the exact source and direct audience consequence', async () => {
        const { useTeamCredentialResourceDraft } = await import('./teamCredentialEditorDraft');
        const hook = await renderHook(() => useTeamCredentialResourceDraft({ targetKey: 'home-a:account-a:team-a:new' }));

        act(() => {
            hook.getCurrent().setDraft((current) => ({
                ...current,
                name: 'Credential',
                source: {
                    v: 1,
                    kind: 'provider_connection',
                    connectionId: ProviderConnectionIdSchema.parse('connection-a'),
                    connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema.parse('connection-security:v1:source-a'),
                    credentialSlotId: ProviderLocalIdSchema.parse('apiKey'),
                },
                deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] },
                brokerPlacement: { kind: 'machine', machineId: 'machine-a' },
                audience: {
                    ...current.audience,
                    members: new Map([['membership-a', ['direct']]]),
                },
            }));
        });
        act(() => {
            hook.getCurrent().acceptDisclosure();
        });
        expect(hook.getCurrent().disclosureAccepted).toBe(true);

        // Non-disclosure fields do not make the person repeat the same consent.
        act(() => hook.getCurrent().setDraft((current) => ({
            ...current,
            brokerPlacement: { kind: 'machine', machineId: 'machine-b' },
            name: 'Renamed',
            requestPolicy: { ...current.requestPolicy, allowedModelIds: ['model-a'] },
        })));
        expect(hook.getCurrent().disclosureAccepted).toBe(true);

        // Narrowing the ceiling removes the direct consequence entirely.
        act(() => hook.getCurrent().setDraft((current) => ({
            ...current,
            deliveryPolicy: { preferredAllowedModes: ['brokered'] },
        })));
        expect(hook.getCurrent().disclosureAccepted).toBe(true);

        act(() => hook.getCurrent().setDraft((current) => ({
            ...current,
            deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] },
        })));
        act(() => hook.getCurrent().acceptDisclosure());

        act(() => hook.getCurrent().setDraft((current) => ({
            ...current,
            source: current.source?.kind === 'provider_connection'
                ? { ...current.source, connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema.parse('connection-security:v1:source-b') }
                : current.source,
        })));
        expect(hook.getCurrent().disclosureAccepted).toBe(false);

        act(() => hook.getCurrent().acceptDisclosure());

        // A new direct recipient changes the material disclosure consequence.
        act(() => hook.getCurrent().setDraft((current) => ({
            ...current,
            audience: {
                ...current.audience,
                members: new Map([['membership-a', ['direct']], ['membership-b', ['direct']]]),
            },
        })));
        expect(hook.getCurrent().disclosureAccepted).toBe(false);
    });

    it('fingerprints the complete draft deterministically, including unordered audience and invalid raw limit input', async () => {
        const {
            EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT,
            teamCredentialResourceDraftFingerprint,
        } = await import('./teamCredentialEditorDraft');
        const left = {
            ...EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT,
            audience: {
                allMembers: ['brokered'] as const,
                groups: new Map([['group-b', ['direct'] as const], ['group-a', ['brokered'] as const]]),
                members: new Map([['member-b', ['brokered', 'direct'] as const], ['member-a', ['direct'] as const]]),
            },
            requestPolicy: {
                ...EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT.requestPolicy,
                allowedModelIds: ['model-b', 'model-a'],
            },
            limits: [{
                id: 'limit-a',
                subjectKind: 'resource' as const,
                subjectId: '',
                metric: 'total_tokens' as const,
                period: 'month' as const,
                maximum: 'also-invalid-yet',
                enabled: true,
            }],
        };
        const right = {
            ...left,
            audience: {
                ...left.audience,
                groups: new Map([...left.audience.groups].reverse()),
                members: new Map([...left.audience.members].reverse()),
            },
            requestPolicy: {
                ...left.requestPolicy,
                allowedModelIds: ['model-a', 'model-b'],
            },
        };

        expect(teamCredentialResourceDraftFingerprint(left)).toBe(teamCredentialResourceDraftFingerprint(right));
        expect(teamCredentialResourceDraftFingerprint(left)).not.toBe(
            teamCredentialResourceDraftFingerprint({
                ...right,
                limits: [{ ...right.limits[0]!, maximum: 'different-invalid-value' }],
            }),
        );
    });
});

describe('credential draft navigation', () => {
    it('joins a dirty resource draft to the standard before-remove guard', async () => {
        const { useUnsavedDraftNavigationGuard } = await import('@/utils/navigation/useUnsavedDraftNavigationGuard');
        const navigation = { isFocused: () => true, addListener: () => () => {}, dispatch: vi.fn() };
        const hook = await renderHook(
            ({ isDirty }) => useUnsavedDraftNavigationGuard({
                navigation,
                isDirty,
                onDiscard: vi.fn(),
                tag: 'team-credential-draft.test',
            }),
            { initialProps: { isDirty: false } },
        );
        expect(preventRemoveState.enabled).toBe(false);

        await hook.rerender({ isDirty: true });
        expect(preventRemoveState.enabled).toBe(true);
    });
});
