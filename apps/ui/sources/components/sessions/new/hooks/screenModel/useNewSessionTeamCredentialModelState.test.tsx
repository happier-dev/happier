import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { SessionTeamCredentialBindingIntentsV1Schema } from '@happier-dev/protocol/teams';
import { SessionModelSelectionV2Schema, sessionModelSelectionV2TeamBindingIntent } from '@happier-dev/protocol/providers/selection/v2';

import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { useNewSessionTeamCredentialModelState } from './useNewSessionTeamCredentialModelState';

describe('New Session Team model intent', () => {
    it.each(['brokered', 'vendor-native'] as const)('reopens a %s Team model from its source-bearing binding without a V1 carrier', async (deliveryMode) => {
        const nativeDelivery = deliveryMode === 'vendor-native' ? {
            managedId: 'managed', controllerInstallationId: 'controller', guestInstallationId: 'guest',
            bindingKey: 'binding', placeholderRef: 'reference', sourceRevision: 'source:1', providerTicket: 'a'.repeat(43),
        } : undefined;
        const selection = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 7, ref: {
            source: 'team_resource', teamId: 'team-a', resourceId: 'resource-a', expectedResourceRevision: 7,
            deliveryMode, agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'team-model',
            ...(nativeDelivery ? { nativeDelivery } : {}),
        } });
        const teamCredentialBindings = SessionTeamCredentialBindingIntentsV1Schema.parse([
            sessionModelSelectionV2TeamBindingIntent(selection),
        ]);
        const props: Parameters<typeof useNewSessionTeamCredentialModelState>[0] = {
            serverId: 'home-a', accountId: 'account-a', draftId: 'draft-a',
            draft: { modelSelection: null, teamCredentialBindings },
        };
        const hook = await renderHook(useNewSessionTeamCredentialModelState, { initialProps: props });
        try {
            expect(hook.getCurrent()[0]).toEqual({ kind: 'team_credential_provider_model',
                teamId: 'team-a', resourceId: 'resource-a', expectedResourceRevision: 7,
                deliveryMode, agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'team-model',
                ...(nativeDelivery ? { nativeDelivery } : {}),
            });
            await hook.rerender({ ...props, draftId: 'draft-native', draft: { modelSelection: null } });
            expect(hook.getCurrent()[0]).toBeNull();
            await hook.rerender({ ...props, draftId: 'draft-cleared', draft: { modelSelection: null,
                teamCredentialBindings: SessionTeamCredentialBindingIntentsV1Schema.parse([
                    { v: 1, slot: { kind: 'provider_model' }, resourceId: null },
                ]),
            } });
            expect(hook.getCurrent()[0]).toBeNull();
        } finally { await hook.unmount(); }
    });

    it('hydrates before the consuming commit, preserves explicit clears, and isolates draft custody', async () => {
        type Input = Parameters<typeof useNewSessionTeamCredentialModelState>[0];
        const draft = {
            modelSelection: SessionModelSelectionV1Schema.parse({ v: 1, updatedAt: 1,
                ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5' } }),
            teamCredentialBindings: SessionTeamCredentialBindingIntentsV1Schema.parse([{ v: 1,
                slot: { kind: 'provider_model' }, teamId: 'team-a', resourceId: 'resource-a',
                expectedResourceRevision: 7, deliveryMode: 'brokered' }]),
        };
        const props: Input = { serverId: 'home-a', accountId: 'account-a', draftId: 'draft-a', draft: null };
        let commits = 0;
        const wrapper = ({ children }: React.PropsWithChildren) => <React.Profiler id="team-intent"
            onRender={() => { commits++; }}>{children}</React.Profiler>;
        const hook = await renderHook(useNewSessionTeamCredentialModelState, { initialProps: props, wrapper });
        try {
            expect(hook.getCurrent()[0]).toBeNull();
            commits = 0;
            await hook.rerender({ ...props, draft });
            expect(commits).toBe(1);
            const selected = hook.getCurrent()[0];
            expect(selected).toMatchObject({ teamId: 'team-a', resourceId: 'resource-a', modelId: 'gpt-5' });
            commits = 0;
            for (let i = 0; i < 100; i++) await hook.rerender({ ...props, draft });
            expect(commits).toBe(100);
            expect(hook.getCurrent()[0]).toBe(selected);
            await act(async () => { hook.getCurrent()[1](null); });
            await hook.rerender({ ...props, draft: { ...draft } });
            expect(hook.getCurrent()[0]).toBeNull();
            await hook.rerender({ ...props, accountId: 'account-b', draft });
            expect(hook.getCurrent()[0]).toEqual(selected);
            await act(async () => { hook.getCurrent()[1](null); });
            await hook.rerender({ ...props, accountId: 'account-b', draftId: 'draft-b', draft });
            expect(hook.getCurrent()[0]).toEqual(selected);
            await hook.rerender({ ...props, draft: { modelSelection: draft.modelSelection } });
            expect(hook.getCurrent()[0]).toBeNull();
        } finally { await hook.unmount(); }
    });
});
