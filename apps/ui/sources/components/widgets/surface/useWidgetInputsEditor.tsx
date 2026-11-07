import * as React from 'react';
import type { View } from 'react-native';
import type { WidgetInputBindingsV1, WidgetInstanceV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

import { WidgetSetupPopover } from '@/components/widgets/add/WidgetSetupPopover';
import type { WidgetSetupDraft, WidgetSetupSubmitResult } from '@/components/widgets/add/widgetSetupModel';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { WidgetInputRepairOutcome } from '@/sync/domains/widgets/widgetBinding';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { readSessionWidgetProvidedContext } from './sessionWidgetContext';

import { useWidgetInstanceBindingLabel } from './useWidgetInstanceBindingLabel';
import { WidgetSetupPreview } from './WidgetSetupPreview';
import {
    buildWidgetCandidateSetup,
    isConfigurableWidgetCandidate,
    widgetProvidedContext,
    type WidgetSurfaceContext,
} from './widgetSurfaceSetup';

const UNBOUND: Pick<WidgetInstanceV1, 'bindings'> = Object.freeze({ bindings: {} });

/**
 * A Session Board or Companion as a qualified widget surface, and what it fills on its own: its
 * Session, as "This session". Absent when the viewer's Account is on another server than the Session.
 */
export function useSessionWidgetSurface(input: Readonly<{
    owner: 'sessionBoard' | 'companion';
    serverId: string | null | undefined;
    sessionId: string;
    session?: Session | null;
}>): Readonly<{ scope: WidgetSurfaceRefV1 | null; context: WidgetSurfaceContext }> {
    const account = useActiveServerAccountScope();
    const { owner, serverId, sessionId, session } = input;
    const label = session && serverId ? getSessionName(session, serverId) : sessionId;
    const scope = React.useMemo<WidgetSurfaceRefV1 | null>(() => (
        account && serverId && account.serverId === serverId
            ? { serverId, accountId: account.accountId, owner: { kind: owner, sessionId } }
            : null
    ), [account, owner, serverId, sessionId]);
    const provided = React.useMemo(() => serverId ? readSessionWidgetProvidedContext({ serverId, sessionId, session }) : {}, [serverId, sessionId, session]);
    const machine = provided.machine?.[0];
    const context = React.useMemo<WidgetSurfaceContext>(() => (serverId
        ? { session: { ref: { serverId, sessionId }, label }, slots: {
            machine: { label: t('machines.widgets.followsSessionMachine'), value: machine
                ? { value: machine, label: t('machines.widgets.followsSessionMachine') } : null },
        } }
        : {}), [label, serverId, sessionId, machine]);
    return React.useMemo(() => ({ scope, context }), [context, scope]);
}

/**
 * Edit inputs and in-card repair for one placed copy (lab `dashboards` dbind E/Ep, dagent ST), on any
 * surface: the ⋯ menu's entry repeats the current binding, and both it and the card's repair line
 * open the same step as Set up, anchored to the ⋯. Saving changes only this copy, through the
 * surface's own write (`setInputs`); its definition and the other copies stay as they are.
 *
 * Nothing is offered for a widget without inputs, or where this viewer cannot change the copy.
 */
export function useWidgetInputsEditor(input: Readonly<{
    /** The placed copy; `null` while the item is not a configured widget (nothing is offered). */
    instance: WidgetInstanceV1 | null;
    candidate: WidgetCandidate | null | undefined;
    scope: WidgetSurfaceRefV1 | null;
    context: WidgetSurfaceContext;
    /** Shared surfaces bind connections per viewer; personal ones keep what the person chose. */
    audience: 'personal' | 'shared';
    /** The surface's canonical inputs write for this copy; absent when it cannot be changed here. */
    setInputs?: (bindings: WidgetInputBindingsV1) => Promise<WidgetSetupSubmitResult>;
    testID: string;
}>): Readonly<{
    anchorRef: React.RefObject<View | null>;
    editInputs: Readonly<{ onPress: (event?: unknown, callerContext?: ActionExecutorContext) => void; binding: string | null }> | undefined;
    /** The card's repair opens the same step, at the input it names. */
    onRepairInputs: ((outcome?: WidgetInputRepairOutcome) => void) | undefined;
    popover: React.ReactElement | null;
}> {
    const anchorRef = React.useRef<View | null>(null);
    const [open, setOpen] = React.useState<Readonly<{ callerContext?: ActionExecutorContext }> | null>(null);
    // The input a repair named, opened ready to choose (lab ST "repair in place").
    const [focusPath, setFocusPath] = React.useState<string | null>(null);
    const binding = useWidgetInstanceBindingLabel(input.instance ?? UNBOUND, input.candidate, input.context);
    const candidate = input.candidate;
    const editable = input.instance !== null && candidate != null && isConfigurableWidgetCandidate(candidate)
        && input.setInputs !== undefined && input.scope !== null;
    const commands = useCurrentUiContextLocalCommands(editable ? [
        { key: 'open', title: `${t('widgetAdd.editInputs')}: ${candidate.title}`, invoke: (value: unknown, callerContext?: ActionExecutorContext) => {
            setFocusPath(typeof value === 'string' ? value : null); setOpen({ callerContext });
        } },
        ...(open ? [{ key: 'close', title: `${t('common.close')}: ${candidate.title}`, invoke: () => setOpen(null) }] : []),
    ] : [], { unbound: 'local' });
    const close = React.useCallback(() => { void commands.invoke('close'); }, [commands]);
    const show = React.useCallback((_event?: unknown, callerContext?: ActionExecutorContext) => {
        void commands.invoke('open', undefined, callerContext);
    }, [commands]);
    const repair = React.useCallback((outcome?: WidgetInputRepairOutcome) => {
        void commands.invoke('open', outcome?.field?.path);
    }, [commands]);
    const editInputs = React.useMemo(() => (editable ? { onPress: show, binding } : undefined), [binding, editable, show]);

    const { instance, scope, context, audience, setInputs, testID } = input;
    const buildSetup = React.useCallback(() => buildWidgetCandidateSetup({
        candidate: candidate!,
        context,
        audience,
        mode: { kind: 'edit', instance: instance! },
        scope,
        submit: (draft) => setInputs!(draft.bindings),
        ...(scope ? {
            renderPreview: ({ draft }: Readonly<{ draft: WidgetSetupDraft }>) => (
                <WidgetSetupPreview
                    scope={scope}
                    providedContext={widgetProvidedContext(context)}
                    projectContext={context.projectContext}
                    candidate={candidate!}
                    draft={draft}
                    testID={`${testID}.editInputs.preview`}
                />
            ),
        } : {}),
    }), [audience, candidate, context, instance, scope, setInputs, testID]);

    const sessionId = scope && (scope.owner.kind === 'sessionBoard' || scope.owner.kind === 'companion') ? scope.owner.sessionId : null;
    const popover = editable && open ? (
        <WidgetSetupPopover
            open
            anchorRef={anchorRef}
            setup={buildSetup}
            callerContext={open.callerContext}
            onRequestClose={close}
            serverId={scope!.serverId}
            {...(sessionId ? { sessionId } : {})}
            {...(focusPath ? { focusPath } : {})}
            testID={`${testID}.editInputs`}
        />
    ) : null;
    return { anchorRef, editInputs, onRepairInputs: editable ? repair : undefined, popover };
}
