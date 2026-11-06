import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { buildApprovalPreviewSummary } from '@happier-dev/protocol/actions/actionExecutor';
import { describeApprovalActionFields, type ApprovalActionReference } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { resolveActionConfirmVerb, resolveActionSummary, resolveActionTitle } from '@/text/actionTitles';
import { t } from '@/text';
import { getPreferredLanguage } from '@/text/i18n';
import type { RoleCatalogEntry } from '@/sync/domains/roles/roleCatalog';
import { RoleActionInputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { WidgetLayoutFragmentActionIdV1Schema, readWidgetApprovalPresentationV1 } from '@happier-dev/protocol/widgets';
import { presentLocalServiceControlApproval, readLocalServiceControlSubject } from './localServiceControlApprovalPresentation';

export type ActionApprovalPresentationInput = Readonly<{
    actionId: string;
    actionArgs?: unknown;
    preview?: unknown;
    authoredTitle?: string | null;
    authoredSummary?: string | null;
    subject?: string | null;
    role?: RoleCatalogEntry | null;
    /** The target Machine's readable path form (home-relative), when the presenting app knows its home. */
    formatPath?: ((path: string) => string) | null;
}>;

export type ApprovalSummaryInput = Readonly<{ actionId: string; actionArgs: unknown }>;

/** A supplied request summary reads through its domain owner; absent previews remain absent. */
export function readApprovalPreviewSummary(preview: unknown, request?: ApprovalSummaryInput): string | null {
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;
    const storedSummary = typeof (preview as { summary?: unknown }).summary === 'string'
        ? (preview as { summary: string }).summary.trim()
        : '';
    if (!storedSummary) return null;
    const actionId = request ? ActionIdSchema.safeParse(request.actionId) : null;
    if (actionId?.success) {
        // The library owner captured this name before the mutation. Raw delete
        // operands contain only an id and cannot re-derive that description.
        if (WidgetLayoutFragmentActionIdV1Schema.safeParse(actionId.data).success
            && 'widgetLibraryName' in preview && typeof preview.widgetLibraryName === 'string' && preview.widgetLibraryName.trim()) return storedSummary;
        const spec = getActionSpec(actionId.data);
        if (readWidgetApprovalPresentationV1(preview)) return presentActionApproval({ actionId: actionId.data,
            actionArgs: request?.actionArgs, preview }).summary;
        const summary = spec.approvalPresentation && (spec.inputSchema.safeParse(request?.actionArgs).success
            || spec.approvalPresentation.inputSchema?.safeParse(request?.actionArgs).success)
            ? spec.approvalPresentation?.summary(request?.actionArgs) : null;
        return presentActionApproval({ actionId: actionId.data, actionArgs: request?.actionArgs,
            authoredSummary: summary || storedSummary }).summary;
    }
    return storedSummary;
}

/** Only the Account override Actions name an Account catalog Role. */
export function readActionApprovalRoleId(input: ActionApprovalPresentationInput): string | null {
    if (input.actionId !== 'roles.override.set' && input.actionId !== 'roles.override.reset') return null;
    const parsed = RoleActionInputSchemasV1[input.actionId].safeParse(input.actionArgs);
    return parsed.success ? parsed.data.roleId : null;
}

/** The existing Protocol reference projection owns subject identity, never a caller's id guess. */
export function readActionApprovalSubject(input: ActionApprovalPresentationInput): ApprovalActionReference | undefined {
    const serviceControl = readLocalServiceControlSubject(input);
    if (serviceControl) return serviceControl;
    const references = describeApprovalActionFields({ ...input, actionArgs: input.actionArgs }).rows.flatMap(row => row.kind === 'value'
        ? [...(row.reference ? [row.reference] : []), ...(row.entries?.flatMap(entry => entry.reference ? [entry.reference] : []) ?? [])]
        : []);
    // A workspace-sync request is titled by its Action; its controller machine and linked folders read in Details.
    if (input.actionId.startsWith('workspace.sync.')) return undefined;
    // The Home only routes the request: the thing acted on (a Machine, a Session) is the subject when there is one.
    return references.find(reference => reference.kind !== 'home') ?? references[0];
}

/** One UI copy boundary for confirmation, Inbox, page and preview; authored plugin copy stays authored. */
export function presentActionApproval(input: ActionApprovalPresentationInput): Readonly<{ title: string | null; summary: string | null; confirmLabel: string | null; destructive?: boolean }> {
    const serviceControl = presentLocalServiceControlApproval({ actionId: input.actionId, actionArgs: input.actionArgs, subject: input.subject });
    const parsed = ActionIdSchema.safeParse(input.actionId);
    if (!parsed.success) return { title: input.authoredTitle?.trim() || null, summary: input.authoredSummary?.trim() || null, confirmLabel: null };
    const spec = getActionSpec(parsed.data);
    if (serviceControl) return { ...serviceControl, confirmLabel: resolveActionConfirmVerb(spec.confirmVerb), destructive: spec.irreversible === true };
    const role = input.role?.roleId === readActionApprovalRoleId(input) ? input.role : null;
    const roleKind = role ? role.source === 'built_in' ? t('roles.settings.sourceBuiltIn')
        : role.source === 'user' ? t('roles.settings.sourceYours')
        : role.source === 'shared' ? t('roles.settings.sourceShared') : t('roles.settings.groupPlugins') : null;
    const roleIdentity = role && roleKind ? { name: role.role.name, kind: roleKind } : undefined;
    const english = getPreferredLanguage() === 'en';
    const titleSource = roleIdentity || !english ? resolveActionTitle(spec.id, spec) : spec.title;
    const widgetPresentation = readWidgetApprovalPresentationV1(input.preview);
    const summarySource = buildApprovalPreviewSummary(spec, input.actionArgs, {
        ...(input.formatPath ? { formatPath: input.formatPath } : {}), ...(widgetPresentation ? { widgetPresentation } : {}),
    });
    const authoredSummary = input.authoredSummary?.trim();
    const distinctAuthoredSummary = authoredSummary && authoredSummary !== summarySource ? authoredSummary : null;
    const summary = distinctAuthoredSummary ? distinctAuthoredSummary
        : t('actionPresentation.summary', { actionId: spec.id,
            source: summarySource === `${spec.title}.` ? `${titleSource}.`
                : english ? summarySource : resolveActionSummary(spec.id, summarySource), subject: input.subject, role: roleIdentity });
    const visibleSummary = !distinctAuthoredSummary && summarySource === `${spec.title}.`
        && (summary === titleSource || summary === `${titleSource}.`) ? null : summary;
    // Backup authority follows the Action into both confirmation and Inbox, including authored previews.
    const disclosure = spec.id === 'relay.runtime.personal_home.backup' ? t('personalHome.settings.backupDisclosureBody') : null;
    const title = t('actionPresentation.title', { actionId: spec.id, source: titleSource,
        subject: roleIdentity ? `${roleIdentity.name} · ${roleIdentity.kind}` : input.subject });
    const confirmLabel = resolveActionConfirmVerb(spec.confirmVerb);
    return {
        confirmLabel,
        title,
        summary: disclosure ? [visibleSummary, disclosure].filter(Boolean).join('\n\n') : visibleSummary,
        ...(spec.irreversible ? { destructive: true } : {}),
    };
}
