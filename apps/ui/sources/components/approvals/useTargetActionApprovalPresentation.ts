import * as React from 'react';
import {
    projectTargetActionApprovalInput,
    resolveTargetActionConfirmationPresentation,
} from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { ApprovalPresentationContext } from '@happier-dev/protocol/actions/actionSpecs';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';

import { useAppShellPluginUiDeclarationSources } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { formatActionInputFieldChoice } from '@/components/sessions/actions/ActionInputFields';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import {
    createPluginProjectedActionReviewResolver,
    resolvePluginActionConfirmationDecision,
    resolvePluginProjectedActionPresentation,
} from '@/sync/domains/plugins/ui/actionPresentation';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

export function useTargetActionApprovalPresentation(
    request: TargetActionApprovalRequestV1 | null,
    accountLifetime: ServerCredentialAccountScopeBinding | null,
) {
    const declarations = useAppShellPluginUiDeclarationSources();
    const projection = !declarations.accountLifetime
        || areServerAccountScopesEqual(declarations.accountLifetime.scope, accountLifetime?.scope)
        ? declarations.projection : null;
    const localize = usePluginLocalizedTextResolver({ projection });
    const review = React.useMemo(() => {
        const identity = parseQualifiedPluginActionId(request?.qualifiedActionId);
        if (!request || !identity) return null;
        const action = createPluginProjectedActionReviewResolver(projection)(identity);
        if (!action) return null;
        const input = projectTargetActionApprovalInput(request.input, request.secretInputPaths);
        const confirmation = resolveTargetActionConfirmationPresentation(action.confirmation, input);
        const decision = resolvePluginActionConfirmationDecision(action, confirmation, text => localize(identity.pluginId, text));
        const { inputHints } = resolvePluginProjectedActionPresentation({ pluginId: identity.pluginId, presentation: action, projection, localize });
        const fields = inputHints?.fields.length && !request.inputFields?.length && input
            ? resolveEffectiveActionInputFields({ inputHints }, input.input).filter(field => field.widget !== 'secret')
            : null;
        const draft = input?.input;
        return { decision: decision.destructive ? decision : null, irreversible: action.irreversible === true, fields,
            draftInput: draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : undefined };
    }, [localize, projection, request]);
    const requests = React.useMemo(() => (review?.fields ?? []).flatMap(field =>
        (field.widget === 'select' || field.widget === 'multiselect') && (field.inputType || field.optionsSourceId)
            ? [{ field, actionId: request?.qualifiedActionId, draftInput: review?.draftInput }]
            : []), [request?.qualifiedActionId, review]);
    // The existing field-options owner resolves names using the reviewing Home and its admitted credential.
    const { resolveOptions } = useInputFieldOptions({ requests, accountLifetime,
        serverId: accountLifetime?.scope.serverId, enabled: requests.length > 0 && accountLifetime !== null });
    const fieldPresentation = React.useMemo<ApprovalPresentationContext['targetActionFieldPresentation']>(() => {
        if (!review?.fields) return undefined;
        const byPath = new Map(review.fields.map(field => [field.path, field]));
        return {
            fields: review.fields.map(field => ({ path: field.path, title: field.title ?? field.path })),
            formatValue: (path, value) => {
                const field = byPath.get(path);
                return field && (field.options || field.inputType || field.optionsSourceId)
                    ? formatActionInputFieldChoice(field, value, resolveOptions) : null;
            },
        };
    }, [resolveOptions, review]);
    return { fieldPresentation, decision: review?.decision, irreversible: review?.irreversible ?? false };
}
