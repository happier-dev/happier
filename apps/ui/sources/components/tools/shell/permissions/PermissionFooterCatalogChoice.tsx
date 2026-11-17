import * as React from 'react';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionPermissionChoice } from '@/sync/ops/sessionPermissionChoices';
import { PermissionFooterOfferedChoices } from './PermissionFooterOfferedChoices';
import { McpAlwaysAllowDecisionView } from './McpAlwaysAllowDecision';
import { useMcpAlwaysAllow } from './useMcpAlwaysAllow';

type CatalogChoice = SessionPermissionChoice & Required<Pick<SessionPermissionChoice, 'catalog' | 'followUp'>>;

/** Offered catalog consent uses the same request-owned save receipt as stored approvals. */
export function PermissionFooterCatalogChoice(props: Readonly<{
    choice: CatalogChoice;
    requestId: string;
    turnId?: string;
    scope: ServerAccountScope | null;
    canWriteCatalog: boolean;
    pending: boolean;
    answer(feedback?: string): Promise<void>;
    choicesProps: React.ComponentProps<typeof PermissionFooterOfferedChoices>;
}>) {
    const feedback = React.useRef<string | undefined>(undefined);
    const always = useMcpAlwaysAllow({
        requestId: props.requestId, turnId: props.turnId,
        source: props.choice.catalog.source, identity: props.choice.catalog.identity,
        choiceId: props.choice.id, followUp: props.choice.followUp,
        scope: props.scope, canWriteCatalog: props.canWriteCatalog,
        answerForSession: () => props.answer(feedback.current),
    });
    return <>
        {props.pending && !always.answered ? <PermissionFooterOfferedChoices {...props.choicesProps}
            busyChoiceId={always.status === 'answering' ? props.choice.id : props.choicesProps.busyChoiceId}
            disabled={props.choicesProps.disabled || always.status === 'answering'}
            onChoose={(choiceId, note) => {
                if (choiceId !== props.choice.id) { props.choicesProps.onChoose(choiceId, note); return; }
                feedback.current = note;
                void always.allow();
            }} /> : null}
        <McpAlwaysAllowDecisionView identity={props.choice.catalog.identity} pending={props.pending}
            controller={always} renderDecision={() => null} />
    </>;
}
