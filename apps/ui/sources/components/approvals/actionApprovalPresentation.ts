import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema, REGISTRY_SOURCE_DELETE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { PROVIDER_CONNECTION_DELETE_ACTION_ID_V1 } from '@happier-dev/protocol/providers/providerActionIdsV1';
import { buildApprovalPreviewSummary } from '@happier-dev/protocol/actions/actionExecutor';
import { describeApprovalActionFields, type ApprovalActionReference } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { resolveActionConfirmVerb, resolveActionSummary, resolveActionTitle } from '@/text/actionTitles';
import { t } from '@/text';
import { getPreferredLanguage } from '@/text/i18n';
import type { RoleCatalogEntry } from '@/sync/domains/roles/roleCatalog';
import { RoleActionInputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { WidgetLayoutFragmentActionIdV1Schema, readWidgetApprovalPresentationV1 } from '@happier-dev/protocol/widgets';
import { presentLocalServiceControlApproval, readLocalServiceControlSubject } from './localServiceControlApprovalPresentation';
import type { ApprovalRequest, ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';

export type ActionApprovalPresentationInput = Readonly<{
    actionId: string;
    /** Immediate product consent names the operation; retained requests keep their approval verb. */
    kind?: 'confirmation';
    actionArgs?: unknown;
    status?: ApprovalRequest['status'];
    preview?: unknown;
    authoredTitle?: string | null;
    authoredSummary?: string | null;
    subject?: string | null;
    executionOriginV1?: ApprovalRequestV2['executionOriginV1'];
    role?: RoleCatalogEntry | null;
    /** The target Machine's readable path form (home-relative), when the presenting app knows its home. */
    formatPath?: ((path: string) => string) | null;
}>;

export type ApprovalSummaryInput = Readonly<{ actionId: string; actionArgs: unknown;
    executionOriginV1?: ApprovalRequestV2['executionOriginV1'] }>;

/** A supplied request summary reads through its domain owner; absent previews remain absent. */
export function readApprovalPreviewSummary(preview: unknown, request?: ApprovalSummaryInput, subject?: string | null): string | null {
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
            ? spec.approvalPresentation?.summary?.(request?.actionArgs) ?? null : null;
        return presentActionApproval({ actionId: actionId.data, actionArgs: request?.actionArgs,
            authoredSummary: summary || storedSummary, subject }).summary;
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
    if (input.actionId === 'scm.diffSummary.result.clear' && input.executionOriginV1?.machineId) {
        return { kind: 'machine', id: input.executionOriginV1.machineId };
    }
    // The Home only routes the request: the thing acted on (a Machine, a Session) is the subject when there is one.
    return references.find(reference => reference.kind !== 'home') ?? references[0];
}

/** Shared by immediate confirmation and retained decisions without rebuilding the consequence body. */
export function readActionApprovalConfirmLabel(actionId: string): string | null {
    const parsed = ActionIdSchema.safeParse(actionId);
    if (!parsed.success) return null;
    if (parsed.data === 'scm.diffSummary.result.clear') return t('walkthroughSettings.clear');
    if (parsed.data === REGISTRY_SOURCE_DELETE_ACTION_ID_V1) return t('capabilities.registries.detail.remove');
    if (parsed.data === PROVIDER_CONNECTION_DELETE_ACTION_ID_V1) return t('common.remove');
    const verb = getActionSpec(parsed.data).confirmVerb;
    return verb === undefined ? null : resolveActionConfirmVerb(verb);
}

/** One UI copy boundary for confirmation, Inbox, page and preview; authored plugin copy stays authored. */
export function presentActionApproval(input: ActionApprovalPresentationInput): Readonly<{ title: string | null; summary: string | null; confirmLabel: string | null; destructive?: boolean }> {
    const serviceControl = presentLocalServiceControlApproval({ actionId: input.actionId, actionArgs: input.actionArgs, subject: input.subject });
    const parsed = ActionIdSchema.safeParse(input.actionId);
    if (!parsed.success) {
        const title = input.authoredTitle?.trim() || input.actionId.trim() || null;
        return { title, summary: input.authoredSummary?.trim() || null, confirmLabel: input.kind === 'confirmation' ? title : null };
    }
    const spec = getActionSpec(parsed.data);
    // Create names a new machine, not its routing Home. The review owner projects the same name for pending and retained asks.
    const createdMachineName = spec.id === 'machines.managed.acquire'
        ? describeApprovalActionFields({ actionId: spec.id, actionArgs: input.actionArgs, status: input.status }).rows
            .find(row => row.kind === 'value' && row.path === 'name') : undefined;
    const subject = createdMachineName?.kind === 'value' ? createdMachineName.value : input.subject;
    const confirmLabel = readActionApprovalConfirmLabel(spec.id)
        ?? (input.kind === 'confirmation' ? resolveActionTitle(spec.id, spec) : resolveActionConfirmVerb(undefined));
    if (spec.id === REGISTRY_SOURCE_DELETE_ACTION_ID_V1) {
        return {
            title: t('actionPresentation.title', { actionId: spec.id,
                source: t('capabilities.registries.detail.remove'), subject }),
            summary: t('capabilities.registries.detail.removeConfirm'),
            confirmLabel,
        };
    }
    // Removing a provider says one verb everywhere: its menu row ("Remove provider"), this title and its button.
    if (spec.id === PROVIDER_CONNECTION_DELETE_ACTION_ID_V1) {
        return {
            title: t('actionPresentation.title', { actionId: spec.id, source: t('settingsProviders.detail.deleteTitle'), subject }),
            summary: t('settingsProviders.detail.deleteDescription'),
            confirmLabel,
            destructive: true,
        };
    }
    if (spec.id === 'scm.diffSummary.result.clear' && spec.inputSchema.safeParse(input.actionArgs).success) {
        return {
            title: t('walkthroughSettings.clearTitle'),
            summary: t('walkthroughSettings.clearDescription', { machine: input.subject?.trim() || t('machine.thisMachineInSentence') }),
            confirmLabel,
            ...(spec.irreversible ? { destructive: true } : {}),
        };
    }
    if (serviceControl) return { ...serviceControl, confirmLabel, destructive: spec.irreversible === true };
    const role = input.role?.roleId === readActionApprovalRoleId(input) ? input.role : null;
    const roleKind = role ? role.source === 'built_in' ? t('roles.settings.sourceBuiltIn')
        : role.source === 'user' ? t('roles.settings.sourceYours')
        : role.source === 'shared' ? t('roles.settings.sourceShared') : t('roles.settings.groupPlugins') : null;
    const roleIdentity = role && roleKind ? { name: role.role.name, kind: roleKind } : undefined;
    const english = getPreferredLanguage() === 'en';
    const titleSource = roleIdentity || !english ? resolveActionTitle(spec.id, spec) : spec.title;
    const widgetPresentation = readWidgetApprovalPresentationV1(input.preview);
    let canonicalCopySummary: string | null = null;
    const summarySource = buildApprovalPreviewSummary(spec, input.actionArgs, {
        ...(input.formatPath ? { formatPath: input.formatPath } : {}), ...(widgetPresentation ? { widgetPresentation } : {}),
        formatSessionVisualCopySummary: summary => {
            canonicalCopySummary = summary.source;
            return t('actionPresentation.sessionVisualCopySummary', summary);
        },
    });
    const authoredSummary = input.authoredSummary?.trim();
    const distinctAuthoredSummary = authoredSummary && authoredSummary !== summarySource && authoredSummary !== canonicalCopySummary
        ? authoredSummary : null;
    const summary = distinctAuthoredSummary ? distinctAuthoredSummary
        : t('actionPresentation.summary', { actionId: spec.id,
            source: summarySource === `${spec.title}.` ? `${titleSource}.`
                : english ? summarySource : resolveActionSummary(spec.id, summarySource), subject, role: roleIdentity });
    const visibleSummary = !distinctAuthoredSummary && summarySource === `${spec.title}.`
        && (summary === titleSource || summary === `${titleSource}.`) ? null : summary;
    // Backup authority follows the Action into both confirmation and Inbox, including authored previews.
    const disclosure = spec.id === 'relay.runtime.personal_home.backup' ? t('personalHome.settings.backupDisclosureBody') : null;
    const title = t('actionPresentation.title', { actionId: spec.id, source: titleSource,
        subject: roleIdentity ? `${roleIdentity.name} · ${roleIdentity.kind}` : subject });
    return {
        confirmLabel,
        title,
        summary: disclosure ? [visibleSummary, disclosure].filter(Boolean).join('\n\n') : visibleSummary,
        ...(spec.irreversible ? { destructive: true } : {}),
    };
}
