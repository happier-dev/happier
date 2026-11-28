import { CurrentUiContextCommandInvokeOutputSchema, getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { TEAM_CREATE_ACTION_ID_V1, TEAM_POLICY_SET_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import { HOME_HUB_LAYOUT_UPDATE_ACTION_ID } from '@happier-dev/protocol/actions/specs/homeHub';
import { readContributedActionReviewV1 } from '@happier-dev/protocol/actions/contributedActionReviewV1';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { ActionIdSchema, CURRENT_UI_CONTEXT_COMMAND_INVOKE_ACTION_ID, REGISTRY_SOURCE_DELETE_ACTION_ID_V1, SESSION_ACCESS_CONTEXT_SET_ACTION_ID_V1, SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { PROVIDER_CONNECTION_DELETE_ACTION_ID_V1 } from '@happier-dev/protocol/providers/providerActionIdsV1';
import { AccountErasureReviewV1Schema } from '@happier-dev/protocol/auth/accountErasureReview';
import { buildApprovalPreviewSummary, readTeamCredentialApprovalSources } from '@happier-dev/protocol/actions/actionExecutor';
import { formatGovernanceChange, formatGovernanceSummary, readGovernanceApprovalPhase, type GovernanceApprovalPhase } from './governanceApprovalSummary';
import { appendTeamCredentialSourceSummary } from '@happier-dev/protocol/actions/specs/teamCredentialApproval';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { MANAGED_ACQUIRE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { MACHINE_REMOVE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machineConnectionActionIdsV1';
import { describeManagedAcquireApprovalLine } from '@/components/settings/machines/managed/managedProvisionerKind';
import { describeApprovalActionFields, readSettledSessionTeamApproval, readTeamMemberApprovalPresentation,
    type ApprovalActionReference, type SettledSessionTeamApproval } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { resolveActionConfirmVerb, resolveActionSummary, resolveActionTitle, resolveBotDraftActionTitle } from '@/text/actionTitles';
import { t } from '@/text';
import { getPreferredLanguage } from '@/text/i18n';
import type { RoleCatalogEntry } from '@/sync/domains/roles/roleCatalog';
import { RoleActionInputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { WidgetLayoutFragmentActionIdV1Schema, readWidgetApprovalPresentationV1 } from '@happier-dev/protocol/widgets';
import { presentLocalServiceControlApproval, readLocalServiceControlSubject } from './localServiceControlApprovalPresentation';
import type { ApprovalRequest, StoredApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { DiscussionPostInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { isDiscussionPostActionIdV1, type DiscussionExternalSourceV1 } from '@happier-dev/protocol/discussions';
import { SettingsDeclarationActionInputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getNewSessionDraftActionIdentity } from '@/components/sessions/new/hooks/useNewSessionDraftPresentation';
import { readVoiceSettingsDeclaration } from '@/voice/settings/voiceContributedSettingsDeclarations';

export type ActionApprovalPresentationInput = Readonly<{
    actionId: string;
    /** Immediate product consent names the operation; retained requests keep their approval verb. */
    kind?: 'confirmation';
    actionArgs?: unknown;
    status?: ApprovalRequest['status'];
    execution?: ApprovalRequest['execution'];
    preview?: unknown;
    authoredTitle?: string | null;
    authoredSummary?: string | null;
    subject?: string | null;
    executionOriginV1?: StoredApprovalRequestV2['executionOriginV1'];
    incomingDiscussionNames?: IncomingDiscussionApprovalNames;
    role?: RoleCatalogEntry | null;
    homeLayoutWidgets?: readonly string[];
    sessionTeamName?: string | null;
    /** The target Machine's readable path form (home-relative), when the presenting app knows its home. */
    formatPath?: ((path: string) => string) | null;
}>;

/** Public presentation facts for the integration named by this incoming message. */
export type IncomingDiscussionApprovalNames = Readonly<{
    providerPluginId: string;
    providerName: string | null;
    ownerName: string | null;
}>;

/** Readable imported provenance exists before publication; private routing is never a label. */
export function readIncomingDiscussionApprovalSource(input: Readonly<{ actionId?: string | null; actionArgs?: unknown }>): DiscussionExternalSourceV1 | null {
    if (!isDiscussionPostActionIdV1(input.actionId ?? '')) return null;
    const parsed = DiscussionPostInputV1Schema.safeParse(input.actionArgs);
    return parsed.success && 'externalSource' in parsed.data.content ? parsed.data.content.externalSource ?? null : null;
}

function formatSettledSessionTeamApproval(approval: SettledSessionTeamApproval, teamName?: string | null): string {
    const summary = approval.kind === 'teamCleared' ? t('session.access.contextCleared')
        : t('session.access.contextSet', { team: approval.teamGrantName ?? teamName ?? t('common.unavailable') });
    const access = approval.grants.length === 0 ? t('session.access.noDirectTeamGrants')
        : approval.grants.map(grant => `${grant.name} — ${t(`session.access.${grant.accessLevel}`)}`).join('\n');
    return `${summary}\n${access}`;
}

/** These Actions' ordinary operands supply the change even when there is no special consequence. */
function readGovernanceSummaryFromInput(spec: ReturnType<typeof getActionSpec>, input: ActionApprovalPresentationInput,
    phase: GovernanceApprovalPhase): string | null {
    if (spec.id === SESSION_ACCESS_CONTEXT_SET_ACTION_ID_V1 && phase === 'completed') {
        const settled = readSettledSessionTeamApproval(input);
        if (settled) return formatSettledSessionTeamApproval(settled, input.sessionTeamName);
    }
    const homeSettings = spec.approvalPresentation?.homeSettingMapInputPaths !== undefined;
    if (!(homeSettings || spec.id === TEAM_CREATE_ACTION_ID_V1 || spec.id === TEAM_POLICY_SET_ACTION_ID_V1
        || spec.id === SESSION_ACCESS_CONTEXT_SET_ACTION_ID_V1)) return null;
    const parsed = spec.inputSchema.safeParse(input.actionArgs);
    if (!parsed.success) return null;
    const args = readRecord(parsed.data);
    if (homeSettings) {
        return formatGovernanceChange(phase, t(args.discardPendingRestart === true
            ? 'actionConfirmations.governance.change.homeSettingsDiscard' : 'actionConfirmations.governance.change.homeSettings'));
    }
    if (spec.id === TEAM_CREATE_ACTION_ID_V1 && typeof args.name === 'string') {
        return formatGovernanceChange(phase, t('actionConfirmations.governance.change.teamCreate', { name: args.name }));
    }
    if (spec.id === TEAM_POLICY_SET_ACTION_ID_V1) {
        return formatGovernanceChange(phase, t('actionConfirmations.governance.change.teamPolicy'));
    }
    const clearing = args.primaryTeamId === null;
    const sentence = formatGovernanceChange(phase, t(clearing
        ? 'actionConfirmations.governance.change.sessionTeamClear' : 'actionConfirmations.governance.change.sessionTeamSet'));
    if (phase !== 'pending') return sentence;
    return [sentence, t('actionConfirmations.governance.sessionTeamGrantsStay'),
        clearing ? null : t('actionConfirmations.governance.sessionTeamPolicyGrant')].filter(Boolean).join(' ');
}

export type ApprovalSummaryInput = Readonly<{ actionId: string; actionArgs: unknown; status?: ApprovalRequest['status'];
    executionOriginV1?: StoredApprovalRequestV2['executionOriginV1']; execution?: ApprovalRequest['execution'] }>;

function readCarriedApprovalSummary(preview: unknown): string | null {
    const { summary } = readRecord(preview);
    return typeof summary === 'string' ? summary.trim() || null : null;
}

/** Typed governance can originate a summary. Other families still need the captured preview. */
export function readApprovalPreviewSummary(preview: unknown, request?: ApprovalSummaryInput, subject?: string | null,
    homeLayoutWidgets?: readonly string[]): string | null {
    const storedSummary = readCarriedApprovalSummary(preview);
    const actionId = request ? ActionIdSchema.safeParse(request.actionId) : null;
    if (!request || !actionId?.success) return storedSummary;
    const presentationInput = { ...request, preview, subject, homeLayoutWidgets };
    if (!storedSummary) {
        if (request.actionArgs == null && !request.execution?.ok) return null;
        const presentation = presentActionApproval(presentationInput);
        return presentation.governance ? presentation.summary : null;
    }
    // A library item's removed name comes from its owner at capture time.
    const libraryName = readRecord(preview).widgetLibraryName;
    if (WidgetLayoutFragmentActionIdV1Schema.safeParse(actionId.data).success
        && typeof libraryName === 'string' && libraryName.trim()) return storedSummary;
    const spec = getActionSpec(actionId.data);
    const captured = readWidgetApprovalPresentationV1(preview) || readTeamCredentialApprovalSources(preview).length > 0;
    const canonical = !captured && spec.approvalPresentation
        && (spec.inputSchema.safeParse(request.actionArgs).success || spec.approvalPresentation.inputSchema?.safeParse(request.actionArgs).success)
        ? spec.approvalPresentation.summary?.(request.actionArgs, { readSettingDeclaration: readVoiceSettingsDeclaration }) : null;
    // A generic Action description cannot replace copy supplied by the receiving owner.
    const authoredSummary = canonical && canonical !== spec.description?.trim() && canonical !== spec.inputHints?.description?.trim()
        ? canonical : storedSummary;
    return presentActionApproval({ ...presentationInput, authoredSummary: captured ? null : authoredSummary }).summary;
}

/** Only the Account override Actions name an Account catalog Role. */
export function readActionApprovalRoleId(input: ActionApprovalPresentationInput): string | null {
    if (input.actionId !== 'roles.override.set' && input.actionId !== 'roles.override.reset') return null;
    const parsed = RoleActionInputSchemasV1[input.actionId].safeParse(input.actionArgs);
    return parsed.success ? parsed.data.roleId : null;
}

/** The existing Protocol reference projection owns subject identity, never a caller's id guess. */
export function readActionApprovalSubject(input: ActionApprovalPresentationInput): ApprovalActionReference | undefined {
    // The captured admission already names both operands; do not issue a second principal lookup.
    if (input.actionId === 'teams.members.add' && readTeamMemberApprovalPresentation(input.preview, input.actionArgs)) return undefined;
    const serviceControl = readLocalServiceControlSubject(input);
    if (serviceControl) return serviceControl;
    // A layout change may act on several widgets. Its title describes the change.
    if (input.actionId === HOME_HUB_LAYOUT_UPDATE_ACTION_ID) return undefined;
    const references = describeApprovalActionFields({ ...input, actionArgs: input.actionArgs }).rows.flatMap(row => row.kind === 'value'
        ? [...(row.reference ? [row.reference] : []), ...(row.entries?.flatMap(entry => entry.reference ? [entry.reference] : []) ?? [])]
        : []);
    // The catalog rows own the exact read of a Preset or Pool. The header only names the Action.
    if (references.some(reference => reference.kind === 'machinePreset' || reference.kind === 'machinePool')) return undefined;
    // Policy is set on the Team. Groups and profiles name the defaults inside that policy.
    if (input.actionId === TEAM_POLICY_SET_ACTION_ID_V1) return references.find(reference => reference.kind === 'team');
    // A workspace-sync request is titled by its Action; its controller machine and linked folders read in Details.
    if (input.actionId.startsWith('workspace.sync.')) return undefined;
    if (input.actionId === 'scm.diffSummary.result.clear' && input.executionOriginV1?.machineId) {
        return { kind: 'machine', id: input.executionOriginV1.machineId };
    }
    // The Home only routes the request: the thing acted on (a Machine, a Session, a person) is the subject when there
    // is one, before the Group and then the Team it happens in.
    const rank = (reference: ApprovalActionReference) => reference.kind === 'home' ? 3
        : reference.kind === 'team' ? 2 : reference.kind === 'group' ? 1 : 0;
    return references.reduce<ApprovalActionReference | undefined>(
        (best, reference) => best === undefined || rank(reference) < rank(best) ? reference : best, undefined);
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

/** The draft a New Session draft Action targets (by `draftId`, or a `newSession` composer ref), read through its identity owner. */
function readNewSessionDraftActionIdentity(actionId: string, actionArgs: unknown) {
    if (resolveBotDraftActionTitle(actionId) === null || !actionArgs || typeof actionArgs !== 'object') return null;
    const args = actionArgs as { draftId?: unknown; ref?: { kind?: unknown; draftId?: unknown } };
    const draftId = typeof args.draftId === 'string' ? args.draftId
        : args.ref?.kind === 'newSession' && typeof args.ref.draftId === 'string' ? args.ref.draftId : null;
    return draftId ? getNewSessionDraftActionIdentity(getActiveServerAccountScope(), draftId, actionId === 'session.draft.delete') : null;
}

/** One UI copy boundary for confirmation, Inbox, page and preview; authored plugin copy stays authored. */
export function presentActionApproval(input: ActionApprovalPresentationInput): Readonly<{
    title: string | null; summary: string | null; confirmLabel: string | null; destructive?: boolean; governance?: true;
}> {
    const serviceControl = presentLocalServiceControlApproval({ actionId: input.actionId, actionArgs: input.actionArgs, subject: input.subject });
    const parsed = ActionIdSchema.safeParse(input.actionId);
    if (!parsed.success) {
        const title = input.authoredTitle?.trim() || input.actionId.trim() || null;
        return { title, summary: input.authoredSummary?.trim() || null, confirmLabel: input.kind === 'confirmation' ? title : null };
    }
    const spec = getActionSpec(parsed.data);
    // A pressed contribution is named by its own declaration (title, verb), never the generic host Action.
    const contributed = spec.id === 'action.invoke' ? readContributedActionReviewV1(input.preview) : null;
    if (contributed) {
        const verb = contributed.confirmVerb === undefined ? '' : resolvePluginLocalizedStringV2Text(contributed.confirmVerb).trim();
        return { title: contributed.title, summary: contributed.description ?? null,
            confirmLabel: verb || (input.kind === 'confirmation' ? contributed.title : resolveActionConfirmVerb(undefined)) };
    }
    if (spec.id === 'settings.invoke') {
        const operation = SettingsDeclarationActionInputSchemasV1['settings.invoke'].safeParse(input.actionArgs);
        const credential = operation.success ? operation.data.input : null;
        if (credential?.kind === 'voice_saved_secret'
            && (credential.operation === 'bind' || credential.operation === 'remove')) {
            const removing = credential.operation === 'remove';
            const title = t(removing ? 'settingsVoice.local.voiceCredential.deleteTitle'
                : 'settingsVoice.local.voiceCredential.useSavedSecretTitle');
            return { title, summary: null, confirmLabel: input.kind === 'confirmation'
                ? removing ? t('common.remove') : title : t('approvals.approve') };
        }
    }
    // Create names a new machine, not its routing Home. The review owner projects the same name for pending and retained asks.
    const createdMachineName = spec.id === 'machines.managed.acquire'
        ? describeApprovalActionFields({ actionId: spec.id, actionArgs: input.actionArgs, status: input.status }).rows
            .find(row => row.kind === 'value' && row.path === 'name') : undefined;
    const teamMember = spec.id === 'teams.members.add'
        ? readTeamMemberApprovalPresentation(input.preview, input.actionArgs) : null;
    const command = spec.id === CURRENT_UI_CONTEXT_COMMAND_INVOKE_ACTION_ID && input.execution?.ok
        ? CurrentUiContextCommandInvokeOutputSchema.safeParse(input.execution.result) : null;
    const commandTitle = command?.success ? command.data.commandTitle : undefined;
    const subject = spec.id === HOME_HUB_LAYOUT_UPDATE_ACTION_ID ? null
        : teamMember ? `${teamMember.accountName} · ${teamMember.teamName}`
        : createdMachineName?.kind === 'value' ? createdMachineName.value : commandTitle ?? input.subject;
    const confirmLabel = readActionApprovalConfirmLabel(spec.id)
        ?? (input.kind === 'confirmation' ? resolveActionTitle(spec.id, spec) : resolveActionConfirmVerb(undefined));
    const incoming = readIncomingDiscussionApprovalSource(input);
    if (incoming) {
        const names = input.incomingDiscussionNames?.providerPluginId === incoming.providerPluginId ? input.incomingDiscussionNames : null;
        return { title: [t('session.collaboration.discussion.controls.incomingMessage'), names?.providerName,
            incoming.conversationDisplayName, names?.ownerName].filter(Boolean).join(' · '),
            summary: null, confirmLabel };
    }
    if (spec.id === REGISTRY_SOURCE_DELETE_ACTION_ID_V1) {
        return {
            title: t('actionPresentation.title', { actionId: spec.id,
                source: t('capabilities.registries.detail.remove'), subject }),
            summary: t('capabilities.registries.detail.removeConfirm'),
            confirmLabel,
        };
    }
    // Removing someone from a Group asks about that person and says what they lose; Details name the Group.
    if (spec.id === 'teams.groups.members.remove') {
        return {
            title: input.kind === 'confirmation'
                ? input.subject?.trim() ? t('teams.groups.removeMemberTitle', { name: input.subject.trim() }) : t('teams.groups.removeNative')
                : t('actionPresentation.title', { actionId: spec.id, source: t('teams.groups.removeNative'), subject }),
            summary: t('teams.groups.removeMemberBody'),
            confirmLabel,
            destructive: true,
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
    // A draft Action names its draft by the draft's own identity: a Bot draft reads as one, a named draft by its
    // name (QA-RERUN-1113 F5; COPY-NOUN-HUNT-1113 open, folder and model).
    const draft = readNewSessionDraftActionIdentity(spec.id, input.actionArgs);
    const draftSubject = draft?.subject;
    const botDraftTitle = draft?.isBot ? resolveBotDraftActionTitle(spec.id) : null;
    const titleSource = botDraftTitle ?? (roleIdentity || !english ? resolveActionTitle(spec.id, spec) : spec.title);
    const widgetPresentation = readWidgetApprovalPresentationV1(input.preview);
    const teamCredentialSources = readTeamCredentialApprovalSources(input.preview);
    const spawnCredentialSuffix = spec.id === SESSION_SPAWN_NEW_ACTION_ID_V1
        ? appendTeamCredentialSourceSummary('', teamCredentialSources) : '';
    let canonicalCopySummary: string | null = null;
    let governanceSummary: string | null = null;
    let homeLayoutTitle: string | null = null;
    const phase = readGovernanceApprovalPhase(input);
    const summarySource = buildApprovalPreviewSummary(spec, input.actionArgs, {
        readSettingDeclaration: readVoiceSettingsDeclaration,
        ...(input.formatPath ? { formatPath: input.formatPath } : {}), ...(widgetPresentation ? { widgetPresentation } : {}),
        teamCredentialSources: spawnCredentialSuffix ? [] : teamCredentialSources,
        ...(teamMember ? { teamMemberPresentation: teamMember } : {}),
        formatGovernanceSummary: review => {
            if (review.kind === 'homeLayout' && (review.effect.kind === 'groupCreate' || review.effect.kind === 'addGroup')) {
                homeLayoutTitle = t('actionConfirmations.governance.homeLayout.groupCreateTitle');
            }
            governanceSummary = formatGovernanceSummary(review, phase, input.homeLayoutWidgets);
            return governanceSummary;
        },
        formatSessionVisualCopySummary: summary => {
            canonicalCopySummary = summary.source;
            return t('actionPresentation.sessionVisualCopySummary', summary);
        },
    });
    governanceSummary ??= readGovernanceSummaryFromInput(spec, input, phase);
    const savedStartSummary = spawnCredentialSuffix ? readRecord(input.preview).summary : undefined;
    const carriedSummary = input.authoredSummary?.trim()
        || (typeof savedStartSummary === 'string' ? savedStartSummary.trim() : undefined);
    // Older signed Start previews carry these same typed facts in their sentence.
    const authoredSummary = spawnCredentialSuffix && carriedSummary?.endsWith(spawnCredentialSuffix)
        ? carriedSummary.slice(0, -spawnCredentialSuffix.length) : carriedSummary;
    // An Action's declared description tells an agent how to call it; it is never the person's review copy,
    // even when a receiver carries it as its summary. The person reads `approvalPresentation.summary` and facts.
    const agentInstructions = authoredSummary === spec.description?.trim() || authoredSummary === spec.inputHints?.description?.trim();
    const distinctAuthoredSummary = authoredSummary && !agentInstructions && authoredSummary !== summarySource
        && authoredSummary !== canonicalCopySummary ? authoredSummary : null;
    const summary = distinctAuthoredSummary ? distinctAuthoredSummary
        : t('actionPresentation.summary', { actionId: spec.id,
            source: summarySource === `${spec.title}.` ? `${titleSource}.`
                : english ? summarySource : resolveActionSummary(spec.id, summarySource), subject, role: roleIdentity });
    const erasure = AccountErasureReviewV1Schema.safeParse(readRecord(input.preview).accountErasure);
    const shareLoss = erasure.success ? erasure.data.sharedEnvironments.map(row => t('homeGovernance.erasureSharedEnvironment', row)) : [];
    const visibleSummary = spec.id === MACHINE_REMOVE_ACTION_ID_V1 ? t('machine.actions.removeMachineConfirmBody')
        : teamMember && !distinctAuthoredSummary ? null
        : !distinctAuthoredSummary && summarySource === `${spec.title}.`
        && (summary === titleSource || summary === `${titleSource}.`) ? null : summary;
    // Backup authority follows the Action into both confirmation and Inbox, including authored previews.
    // A managed Create's fact line names its kind in words and leaves unknown facts out (one presenter for every surface).
    const acquireLine = spec.id === MANAGED_ACQUIRE_ACTION_ID_V1 ? describeManagedAcquireApprovalLine(input.actionArgs) : null;
    const disclosure = spec.id === 'relay.runtime.personal_home.backup' ? t('personalHome.settings.backupDisclosureBody')
        // A Create whose review records the sign-in says it beside what it creates (BL63); older previews omit it.
        : spec.id === MANAGED_ACQUIRE_ACTION_ID_V1 && readRecord(input.preview).accountSignIn === 'requester_confirms'
            ? t('machineSignIn.consequence') : null;
    const confirmationDraftSubject = input.kind === 'confirmation' && spec.id === 'session.draft.delete'
        ? draftSubject : null;
    const subjectInReview = input.kind === 'confirmation' && input.preview !== undefined
        && readActionApprovalSubject(input) !== undefined;
    const title = t('actionPresentation.title', { actionId: spec.id, source: homeLayoutTitle ?? titleSource,
        subject: subjectInReview ? null : roleIdentity ? `${roleIdentity.name} · ${roleIdentity.kind}`
            : subject ?? (confirmationDraftSubject ? null : draftSubject ?? null) });
    return {
        confirmLabel,
        title,
        summary: [confirmationDraftSubject, governanceSummary ?? acquireLine ?? visibleSummary, disclosure, ...shareLoss].filter(Boolean).join('\n\n') || null,
        ...(governanceSummary !== null ? { governance: true } : {}),
        // Archiving a Team ends members' access, so its verb is destructive; a manager restores it, so it is not
        // irreversible and never says it can't be undone.
        ...(spec.irreversible || spec.id === 'teams.archive' ? { destructive: true } : {}),
    };
}
