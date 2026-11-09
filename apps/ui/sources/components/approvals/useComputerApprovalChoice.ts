import * as React from 'react';
import type { ComputerAccessV1, ComputerApprovalDisplayV1, ComputerTargetV1 } from '@happier-dev/protocol/computer/v1';
import { resolveComputerAccess } from '@happier-dev/protocol/computer/v1';

import { noteSessionComputerMachine } from '@/sync/domains/computer/sessionComputerMachines';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useSessionViewerSourceAccountLifetime } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';

import { applyComputerSelection, describeComputerActionApproval, type ComputerActionApproval } from './computerApprovalModel';

type OpenComputerTargetPicker = typeof import('@/components/computer/openComputerTargetPickerForSession').openComputerTargetPickerForSession;

export type ComputerApprovalChoice = Readonly<{
    /** What the approval asks for, with the person's pick applied (null for other Actions). */
    presentation: ComputerActionApproval | null;
    /** Opens the picker for this approval (choose a window, or change the agent's suggestion). */
    chooseTarget: () => void;
    /** What the decision carries: the picked window for an agent's `computer.target.select` (W15). */
    decisionOptions: Readonly<{ narrowedInput?: unknown }>;
    /** Approving an agent's window choice needs an exact window first: Approve opens the picker. */
    needsChoiceBeforeApprove: boolean;
}>;

/**
 * The one owner of a computer approval's person-side choice, for the chat card and the approval page:
 * the request's own display facts (frozen at creation) with the person's pick applied, the picker, and
 * the decision options. For an agent's `computer.target.select` the picker opens on its suggestion and
 * the pick returns here, so approving shares exactly that window with the agent's provenance; for any
 * other computer Action the pick is shared directly by the person.
 */
export function useComputerApprovalChoice(input: Readonly<{
    /** The canonical approval Artifact; choices never transfer to another request. */
    artifactId?: string;
    actionId: string;
    actionArgs: unknown;
    /** Saved decision input for history presentation only; never replaces the signed proposal. */
    approvedInput?: unknown;
    /** What the Action returned, once it ran (the picture an executed capture produced). */
    executionResult?: unknown;
    preview: unknown;
    sessionId: string;
    serverId?: string | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
    /** The picker opener, resolved on the press (surfaces that render without the store pass a require). */
    resolveOpenPicker: () => OpenComputerTargetPicker;
}>): ComputerApprovalChoice {
    const borrowedLifetime = useSessionViewerSourceAccountLifetime();
    const accountLifetime = input.accountLifetime === undefined ? borrowedLifetime : input.accountLifetime;
    const described = React.useMemo(
        () => describeComputerActionApproval({ actionId: input.actionId, actionArgs: input.approvedInput ?? input.actionArgs, preview: input.preview, result: input.executionResult }),
        [input.actionArgs, input.actionId, input.approvedInput, input.executionResult, input.preview],
    );
    const { sessionId, resolveOpenPicker } = input;
    const serverId = input.serverId ?? accountLifetime?.scope.serverId ?? null;
    const machineId = described?.machineId ?? null;
    const owner = React.useMemo(() => ({ accountLifetime, artifactId: input.artifactId, serverId, sessionId, machineId }),
        [accountLifetime, input.artifactId, machineId, serverId, sessionId]);
    const currentOwner = React.useRef<typeof owner | null>(owner);
    currentOwner.current = owner;
    const [choice, setChoice] = React.useState<Readonly<{
        owner: typeof owner;
        display: ComputerApprovalDisplayV1;
        target: ComputerTargetV1 | null;
        access: ComputerAccessV1 | null;
    }> | null>(null);
    const admittedChoice = choice?.owner === owner && accountLifetime?.isCurrent() ? choice : null;
    const chosenDisplay = admittedChoice?.display ?? null;
    const chosenTarget = admittedChoice?.target ?? null;
    const chosenAccess = admittedChoice?.access ?? null;
    React.useEffect(() => {
        currentOwner.current = owner;
        const retirement = accountLifetime?.onRetire(() => {
            setChoice(previous => previous?.owner === owner ? null : previous);
        });
        return () => {
            retirement?.dispose();
            if (currentOwner.current === owner) currentOwner.current = null;
        };
    }, [accountLifetime, owner]);
    const presentation = React.useMemo(
        () => (described ? applyComputerSelection(described, chosenDisplay) : null),
        [chosenDisplay, described],
    );
    const machineName = described?.machineName ?? null;
    React.useEffect(() => {
        if (machineId) noteSessionComputerMachine({ sessionId, serverId, accountLifetime, machineId, machineName });
    }, [accountLifetime, machineId, machineName, serverId, sessionId]);

    const chooseTarget = React.useCallback(() => {
        if (currentOwner.current !== owner || !described || described.act === 'fill' || !accountLifetime?.isCurrent()) return;
        const open = resolveOpenPicker();
        const share = described.act === 'share';
        open({
            sessionId,
            serverId: serverId ?? null,
            accountLifetime,
            machineId: described.machineId,
            machineName: described.machineName,
            access: presentation?.access ?? described.access,
            ...(share
                ? {
                    requestedTarget: described.suggestion ?? null,
                    onChosen: (entry, access) => {
                        if (currentOwner.current !== owner || !accountLifetime.isCurrent()) return;
                        setChoice({ owner, target: entry.target, access, display: {
                            machineDisplayName: described.machineName,
                            requiresTargetSelection: false,
                            access,
                            ...(entry.appName ? { appName: entry.appName } : {}),
                            target: { kind: entry.target.kind, title: entry.target.kind === 'display' ? entry.label ?? entry.title ?? '' : entry.title ?? '' },
                        } });
                    },
                }
                : {}),
            onSelected: (selection) => {
                if (currentOwner.current !== owner || !accountLifetime.isCurrent()) return;
                setChoice({ owner, display: selection.approvalDisplay, target: null, access: null });
            },
        });
    }, [accountLifetime, described, owner, presentation?.access, resolveOpenPicker, serverId, sessionId]);

    const share = described?.act === 'share';
    const exactTargetInRequest = share && Boolean(
        input.actionArgs && typeof input.actionArgs === 'object' && 'target' in input.actionArgs
        && (input.actionArgs as { target?: unknown }).target,
    );
    const decisionOptions = React.useMemo(
        () => (share && chosenTarget ? { narrowedInput: {
            ...(input.actionArgs && typeof input.actionArgs === 'object' ? input.actionArgs : {}),
            target: chosenTarget, access: resolveComputerAccess(chosenAccess),
        } } : {}),
        [chosenAccess, chosenTarget, input.actionArgs, share],
    );
    return {
        presentation,
        chooseTarget,
        decisionOptions,
        needsChoiceBeforeApprove: share && !chosenTarget && !exactTargetInRequest,
    };
}
