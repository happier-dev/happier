import * as React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from '../core/_registry';
import { resolvePermissionRequestId } from '../core/resolvePermissionRequestId';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { sessionAllowWithAnswers } from '@/sync/ops';
import { storage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { Modal } from '@/modal';
import { t } from '@/text';
import { Text, TextInput } from '@/components/ui/text/Text';
import { resolveAgentRequestKind } from '@/utils/sessions/permissions/permissionPromptPolicy';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    useOpenAttachedSessionTerminal,
    type AttachedSessionTerminalUnavailableReason,
} from '@/components/sessions/terminal/openAttachedSessionTerminal';
import {
    compilePluginJsonSchema,
    isValidPluginJsonSchemaValue,
} from '@happier-dev/protocol';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { Icon } from '@/components/ui/icons/Icon';
import { getAgentBehavior } from '@/agents/catalog/catalog';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import type { PluginProjectionEditableSettingField } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { getMachineContributionRegistryProjectionRevision } from '@/sync/ops/machineContributionRegistryProjection';
import {
    resolveScopedPluginSettingsTarget,
    type ScopedPluginSettingsScope,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import {
    resolveScopedPluginSettingsServerIdentity,
    scopedPluginSettingsAdapter,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import {
    commitScopedPluginSettingsField,
    projectScopedPluginSettingsField,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsProjection';


interface QuestionOption {
    answerValue: string;
    label: string;
    description: string;
    settingMutation?: unknown;
}

interface QuestionFreeform {
    placeholder?: string;
    description?: string;
    inputMode: 'singleLine' | 'multiLine';
    initialValue?: string;
    whitespace: 'preserve' | 'trim';
    allowEmpty: boolean;
}

interface Question {
    answerKey: string;
    question: string;
    header?: string;
    options: QuestionOption[];
    multiSelect: boolean;
    required: boolean;
    selection: 'text' | 'single' | 'multiple';
    freeform?: QuestionFreeform;
}

interface AskUserQuestionInput {
    title?: string;
    questions: Question[];
    happierDialog?: unknown;
}

/**
 * A dialog option can carry an Agent-owned candidate setting mutation, but the
 * host accepts it only after the current qualified Agent descriptor allowlists
 * that exact dialog, setting, and value. The declared Account Settings catalog
 * remains the sole persistence authority below this bridge.
 */
type DeclaredAskUserQuestionSettingMutation = Readonly<{
    sessionId: string;
    serverId: string;
    agentId: string;
    machineId: string;
    pluginId: string;
    agentLocalId: string;
    dialogId: string;
    settingId: string;
    fieldId: string;
    projectionGeneration: number;
    projectionRevision: number;
    scope: ScopedPluginSettingsScope;
    field: PluginProjectionEditableSettingField;
    value: string;
}>;

type AskUserQuestionDeclarationAuthority = Readonly<{
    serverId: string;
    agentId: string | null;
    machineId: string | null;
    daemonProjection: ReturnType<typeof useDaemonMergedProjectionInputs>['inputs'];
    projectionRevision: number | null;
}>;

function resolveDeclaredAskUserQuestionSettingFieldId(
    field: PluginProjectionEditableSettingField,
): string | null {
    const projectedField = projectScopedPluginSettingsField(field);
    if (projectedField.binding?.kind === 'perActiveServer') return null;
    const fieldId = projectedField.binding?.kind === 'direct'
        ? projectedField.binding.settingId
        : projectedField.key;
    return fieldId.trim().length > 0 ? fieldId : null;
}

async function persistDeclaredAskUserQuestionSetting(
    input: DeclaredAskUserQuestionSettingMutation & Readonly<{
        resolveCurrentDeclaration: () => DeclaredAskUserQuestionSettingMutation | null;
    }>,
): Promise<void> {
    const serverId = input.serverId;
    const target = resolveScopedPluginSettingsTarget({
        scope: input.scope,
        serverIdentityId: resolveScopedPluginSettingsServerIdentity(serverId),
        machineId: input.machineId,
        serverId,
    });
    if (!target) {
        throw new Error(input.scope.kind === 'account'
            ? 'Unable to persist the selected setting without an exact Account target.'
            : 'Unable to persist the selected setting without an exact daemon target.');
    }
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) {
        throw new Error('Unable to persist the selected setting outside the active Account lifetime.');
    }
    const projectedField = projectScopedPluginSettingsField(input.field);
    if (projectedField.binding?.kind === 'perActiveServer') {
        throw new Error('Unable to persist a selected setting with a server-dependent binding.');
    }
    const isTargetCurrent = (): boolean => {
        const currentSession = storage.getState().sessions[input.sessionId];
        const currentServerId = typeof currentSession?.serverId === 'string'
            ? currentSession.serverId.trim()
            : '';
        if (currentServerId !== serverId) return false;
        const metadata = currentSession ? readSessionOwnerMetadataView(currentSession) : null;
        if (
            resolveAgentIdFromSessionMetadata(metadata) !== input.agentId
            || resolveSessionMachineId(metadata) !== input.machineId
        ) {
            return false;
        }
        const currentDeclaration = input.resolveCurrentDeclaration();
        if (
            !currentDeclaration
            || getMachineContributionRegistryProjectionRevision({
                machineId: input.machineId,
                serverId,
            }) !== input.projectionRevision
        ) {
            return false;
        }
        return currentDeclaration.sessionId === input.sessionId
            && currentDeclaration.serverId === input.serverId
            && currentDeclaration.agentId === input.agentId
            && currentDeclaration.machineId === input.machineId
            && currentDeclaration.pluginId === input.pluginId
            && currentDeclaration.agentLocalId === input.agentLocalId
            && currentDeclaration.dialogId === input.dialogId
            && currentDeclaration.settingId === input.settingId
            && currentDeclaration.fieldId === input.fieldId
            && currentDeclaration.value === input.value
            && currentDeclaration.projectionGeneration === input.projectionGeneration
            && currentDeclaration.projectionRevision === input.projectionRevision
            && currentDeclaration.scope.kind === input.scope.kind;
    };
    const result = await commitScopedPluginSettingsField({
        pluginId: input.pluginId,
        scope: input.scope,
        target,
        accountLifetime,
        fields: [projectedField],
        adapter: scopedPluginSettingsAdapter,
        fieldId: input.fieldId,
        mutation: { kind: 'set', value: input.value },
        isCurrent: isTargetCurrent,
    });
    if (result?.status !== 'ready') {
        throw new Error('Unable to persist the selected setting.');
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function readDialogId(value: unknown): string | null {
    if (!isRecord(value) || typeof value.dialogId !== 'string') return null;
    const dialogId = value.dialogId.trim();
    return dialogId.length > 0 ? dialogId : null;
}

type DeclaredAskUserQuestionDialog = NonNullable<
    ReturnType<typeof getAgentBehavior>['askUserQuestion']
>['dialogs'][number];

function resolveDeclaredAskUserQuestionDialog(
    behavior: ReturnType<typeof getAgentBehavior> | null,
    dialog: unknown,
): DeclaredAskUserQuestionDialog | null {
    const dialogId = readDialogId(dialog);
    if (!dialogId) return null;
    return behavior?.askUserQuestion?.dialogs.find((entry) => entry.dialogId === dialogId) ?? null;
}

function applyDeclaredTerminalNoticePresentation(
    input: AskUserQuestionInput | null,
    dialog: unknown,
    declaration: DeclaredAskUserQuestionDialog | null,
): AskUserQuestionInput | null {
    if (!input || !declaration?.terminalNotice || !isRecord(dialog) || dialog.mode !== 'notice') return input;
    const firstQuestion = input.questions[0];
    if (!firstQuestion || firstQuestion.options.length !== 0) return input;
    return {
        ...input,
        questions: [{
            ...firstQuestion,
            header: t(declaration.terminalNotice.headerKey),
            question: t(declaration.terminalNotice.questionKey),
            options: [],
        }],
    };
}

function resolveOptionSettingMutation(value: unknown): Readonly<{
    settingId: string;
    value: string;
}> | null {
    if (!isRecord(value) || typeof value.settingId !== 'string' || typeof value.value !== 'string') return null;
    const settingId = value.settingId.trim();
    return settingId ? { settingId, value: value.value } : null;
}

function resolveDeclaredAskUserQuestionSettingMutation(input: Readonly<{
    sessionId: string;
    serverId: string;
    agentId: string | null;
    machineId: string | null;
    behavior: ReturnType<typeof getAgentBehavior> | null;
    daemonProjection: ReturnType<typeof useDaemonMergedProjectionInputs>['inputs'];
    projectionRevision: number | null;
    dialog: unknown;
    candidate: unknown;
}>): DeclaredAskUserQuestionSettingMutation | null {
    if (
        !input.serverId
        || !input.agentId
        || !input.machineId
        || !input.daemonProjection?.pluginProjectionV2
        || input.projectionRevision === null
        || !Number.isSafeInteger(input.projectionRevision)
        || input.projectionRevision < 0
    ) {
        return null;
    }
    const projectionGeneration = input.daemonProjection.pluginProjectionV2.generation;
    if (!Number.isSafeInteger(projectionGeneration) || projectionGeneration < 0) return null;
    const declaration = resolveDeclaredAskUserQuestionDialog(input.behavior, input.dialog);
    const declaredMutation = declaration?.settingMutation;
    const candidate = resolveOptionSettingMutation(input.candidate);
    if (
        !declaredMutation
        || !candidate
        || candidate.settingId !== declaredMutation.settingId
        || !declaredMutation.allowedValues.includes(candidate.value)
    ) {
        return null;
    }

    const projectedAgent = input.daemonProjection.pluginProjectionV2.agentsById[input.agentId];
    if (!projectedAgent || projectedAgent.id !== input.agentId || !projectedAgent.identity) return null;
    const identity = projectedAgent.identity;
    const projectionEntry = input.daemonProjection.pluginProjectionById[identity.pluginId];
    if (!projectionEntry) return null;
    const matchingFieldEntries = projectionEntry.editableSettingsGroups
        .filter((group) => (
            group.pluginId === identity.pluginId
            && group.target.kind === 'agent'
            && group.target.agent.pluginId === identity.pluginId
            && group.target.agent.localId === identity.localId
        ))
        .flatMap((group) => group.fields
            .filter((field) => field.key === candidate.settingId)
            .map((field) => ({ field, scope: group.scope })));
    if (matchingFieldEntries.length !== 1) return null;
    const { field, scope } = matchingFieldEntries[0]!;
    if (
        field.valueType !== 'string'
        || field.secretCustody !== null
        || field.redaction !== 'none'
        || field.control === 'password'
    ) {
        return null;
    }
    const fieldId = resolveDeclaredAskUserQuestionSettingFieldId(field);
    if (!fieldId) return null;
    try {
        const validator = compilePluginJsonSchema(field.valueSchema);
        if (!isValidPluginJsonSchemaValue(validator, candidate.value)) return null;
    } catch {
        return null;
    }
    return {
        sessionId: input.sessionId,
        serverId: input.serverId,
        agentId: input.agentId,
        machineId: input.machineId,
        pluginId: identity.pluginId,
        agentLocalId: identity.localId,
        dialogId: declaration.dialogId,
        settingId: candidate.settingId,
        fieldId,
        projectionGeneration,
        projectionRevision: input.projectionRevision,
        scope,
        field,
        value: candidate.value,
    };
}

function normalizeQuestionOption(value: unknown, canonical: boolean): QuestionOption | null {
    if (!isRecord(value) || typeof value.label !== 'string') return null;
    const answerValue = canonical
        ? readOptionalString(value.id)
        : (readOptionalString(value.choice) ?? value.label);
    if (!answerValue) return null;
    return {
        answerValue,
        label: value.label,
        description: readOptionalString(value.description) ?? '',
        ...('settingMutation' in value ? { settingMutation: value.settingMutation } : {}),
    };
}

function normalizeCanonicalQuestion(value: Record<string, unknown>): Question | null {
    if (
        typeof value.id !== 'string'
        || value.id.trim().length === 0
        || typeof value.question !== 'string'
        || (value.selection !== 'text' && value.selection !== 'single' && value.selection !== 'multiple')
    ) {
        return null;
    }

    if (value.selection === 'text') {
        const presentation = isRecord(value.presentation) ? value.presentation : {};
        return {
            answerKey: value.id,
            question: value.question,
            options: [],
            multiSelect: false,
            required: value.required === true,
            selection: 'text',
            freeform: {
                inputMode: presentation.inputMode === 'multiLine' ? 'multiLine' : 'singleLine',
                ...(typeof presentation.placeholder === 'string' ? { placeholder: presentation.placeholder } : {}),
                ...(typeof presentation.initialValue === 'string' ? { initialValue: presentation.initialValue } : {}),
                whitespace: presentation.whitespace === 'preserve' ? 'preserve' : 'trim',
                allowEmpty: presentation.allowEmpty === true,
            },
        };
    }

    const options = Array.isArray(value.options)
        ? value.options.map((option) => normalizeQuestionOption(option, true))
        : [];
    if (options.some((option) => option === null)) return null;
    return {
        answerKey: value.id,
        question: value.question,
        options: options as QuestionOption[],
        multiSelect: value.selection === 'multiple',
        required: value.required === true,
        selection: value.selection,
        ...(value.allowCustom === true
            ? {
                freeform: {
                    inputMode: 'singleLine' as const,
                    whitespace: 'trim' as const,
                    allowEmpty: false,
                },
            }
            : {}),
    };
}

function normalizeLegacyQuestion(value: Record<string, unknown>): Question | null {
    if (typeof value.question !== 'string') return null;
    const header = readOptionalString(value.header);
    const answerKey = value.question.trim().length > 0 ? value.question : header;
    if (!answerKey) return null;
    const options = Array.isArray(value.options)
        ? value.options.map((option) => normalizeQuestionOption(option, false))
        : [];
    if (options.some((option) => option === null)) return null;
    const freeform = isRecord(value.freeform) ? value.freeform : null;
    return {
        answerKey,
        question: value.question,
        ...(header ? { header } : {}),
        options: options as QuestionOption[],
        multiSelect: value.multiSelect === true,
        required: true,
        selection: value.multiSelect === true ? 'multiple' : (options.length === 0 ? 'text' : 'single'),
        ...(freeform || options.length === 0
            ? {
                freeform: {
                    inputMode: 'singleLine' as const,
                    ...(typeof freeform?.placeholder === 'string' ? { placeholder: freeform.placeholder } : {}),
                    ...(typeof freeform?.description === 'string' ? { description: freeform.description } : {}),
                    whitespace: 'trim' as const,
                    allowEmpty: false,
                },
            }
            : {}),
    };
}

function normalizeAskUserQuestionInput(value: unknown): AskUserQuestionInput | null {
    if (!isRecord(value) || !Array.isArray(value.questions) || value.questions.length === 0) return null;
    const questions = value.questions.map((question) => {
        if (!isRecord(question)) return null;
        return 'selection' in question
            ? normalizeCanonicalQuestion(question)
            : normalizeLegacyQuestion(question);
    });
    if (questions.some((question) => question === null)) return null;
    return {
        ...(typeof value.title === 'string' && value.title.trim().length > 0 ? { title: value.title } : {}),
        questions: questions as Question[],
        ...('happierDialog' in value ? { happierDialog: value.happierDialog } : {}),
    };
}

function resolveFreeformAnswer(
    question: Question,
    questionIndex: number,
    freeformAnswers: ReadonlyMap<number, string>,
): { value: string; present: boolean } {
    const hasEditedValue = freeformAnswers.has(questionIndex);
    const rawValue = hasEditedValue
        ? (freeformAnswers.get(questionIndex) ?? '')
        : (question.freeform?.initialValue ?? '');
    return {
        value: question.freeform?.whitespace === 'preserve' ? rawValue : rawValue.trim(),
        present: hasEditedValue || question.freeform?.initialValue !== undefined,
    };
}

function resolveAttachedTerminalUnavailableMessage(
    reason: AttachedSessionTerminalUnavailableReason | null,
): string | null {
    switch (reason) {
        case 'missing_machine':
            return t('terminalEmbedded.errors.missingMachineTarget');
        case 'terminal_disabled':
            return t('terminalEmbedded.errors.disabled');
        case 'cli_update_required':
            return t('deps.ui.notAvailableUpdateCli');
        default:
            return null;
    }
}

function parseAskUserQuestionAnswersFromToolResult(result: unknown): Record<string, string> | null {
    if (!result || typeof result !== 'object') return null;
    const maybeAnswers = (result as any).answers;
    if (!maybeAnswers || typeof maybeAnswers !== 'object' || Array.isArray(maybeAnswers)) return null;

    const answers: Record<string, string> = {};
    for (const [key, value] of Object.entries(maybeAnswers as Record<string, unknown>)) {
        if (typeof value === 'string') {
            answers[key] = value;
        } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
            answers[key] = value.join(', ');
        }
    }
    return answers;
}

// Styles MUST be defined outside the component to prevent infinite re-renders
// with react-native-unistyles. The theme is passed as a function parameter.
const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 16,
    },
    questionSection: {
        gap: 8,
    },
    headerChip: {
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.surface.elevated,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        marginBottom: 4,
    },
    headerText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
        textTransform: 'uppercase',
    },
    questionText: {
        fontSize: 15,
        fontWeight: '500',
        color: theme.colors.text.primary,
        marginBottom: 8,
    },
    optionsContainer: {
        gap: 4,
    },
    optionButton: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingVertical: 12,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        gap: 10,
        minHeight: 44, // Minimum touch target for mobile
    },
    optionButtonSelected: {
        backgroundColor: theme.colors.surface.inset,
        borderColor: theme.colors.radio.active,
    },
    optionButtonDisabled: {
        opacity: 0.6,
    },
    radioOuter: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: theme.colors.text.secondary,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    radioOuterSelected: {
        borderColor: theme.colors.radio.active,
    },
    radioInner: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: theme.colors.radio.dot,
    },
    checkboxOuter: {
        width: 20,
        height: 20,
        borderRadius: 4,
        borderWidth: 2,
        borderColor: theme.colors.text.secondary,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    checkboxOuterSelected: {
        borderColor: theme.colors.radio.active,
        backgroundColor: theme.colors.radio.active,
    },
    optionContent: {
        flex: 1,
    },
    optionLabel: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text.primary,
    },
    optionDescription: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        marginTop: 2,
    },
    freeformInput: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 12,
        fontSize: 14,
        color: theme.colors.text.primary,
        backgroundColor: theme.colors.surface.base,
        minHeight: 44,
    },
    freeformDescription: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        marginTop: 6,
        marginLeft: 2,
    },
    actionsContainer: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 8,
        justifyContent: 'flex-end',
    },
    submitButton: {
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 44, // Minimum touch target for mobile
    },
    submitButtonDisabled: {
        opacity: 0.5,
    },
    submitButtonText: {
        color: theme.colors.button.primary.tint,
        fontSize: 14,
        fontWeight: '600',
    },
    submittedContainer: {
        gap: 8,
    },
    submittedItem: {
        flexDirection: 'row',
        gap: 8,
    },
    submittedHeader: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text.secondary,
    },
    submittedValue: {
        fontSize: 13,
        color: theme.colors.text.primary,
        flex: 1,
    },
}));

export const AskUserQuestionView = React.memo<ToolViewProps>(({ tool, sessionId, interaction }) => {
    const { theme } = useUnistyles();
    const [selections, setSelections] = React.useState<Map<number, Set<number>>>(new Map());
    const [freeformAnswers, setFreeformAnswers] = React.useState<Map<number, string>>(new Map());
    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const [isSubmitted, setIsSubmitted] = React.useState(false);
    const attachedSessionTerminal = useOpenAttachedSessionTerminal(sessionId ?? null);

    // Parse input
    const rawInput = tool.input;
    const session = sessionId ? storage.getState().sessions[sessionId] : undefined;
    const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
    const agentId = resolveAgentIdFromSessionMetadata(ownerMetadata);
    const machineId = resolveSessionMachineId(ownerMetadata);
    const serverId = typeof session?.serverId === 'string' ? session.serverId.trim() : '';
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId,
        serverId: serverId || null,
        enabled: Boolean(sessionId && machineId),
    });
    const daemonProjection = daemonMergedProjection.phase === 'ready'
        ? daemonMergedProjection.inputs
        : null;
    const projectionRevision = machineId && serverId
        ? getMachineContributionRegistryProjectionRevision({ machineId, serverId })
        : null;
    // This ref owns no projection or descriptor state. It lets the post-answer
    // write predicate re-resolve its declaration from the current render while
    // the canonical machine revision fences an invalidation before React can
    // render its successor projection.
    const declarationAuthorityRef = React.useRef<AskUserQuestionDeclarationAuthority | null>(null);
    declarationAuthorityRef.current = {
        serverId,
        agentId,
        machineId,
        daemonProjection,
        projectionRevision,
    };
    const agentBehavior = agentId ? getAgentBehavior(agentId, machineId) : null;
    const normalizedInput = normalizeAskUserQuestionInput(rawInput);
    const declaredDialog = resolveDeclaredAskUserQuestionDialog(
        agentBehavior,
        normalizedInput?.happierDialog,
    );
    const input = applyDeclaredTerminalNoticePresentation(
        normalizedInput,
        normalizedInput?.happierDialog,
        declaredDialog,
    );
    const questions = input?.questions;

    if (!input || !questions || !Array.isArray(questions) || questions.length === 0) {
        return null;
    }

    const isRunning = tool.state === 'running';
    const canApprovePermissions = interaction?.canApprovePermissions ?? true;
    const toolCallId = resolvePermissionRequestId(tool);
    const activeMatchingRequest = toolCallId ? (session as any)?.agentState?.requests?.[toolCallId] : null;
    const hasActiveAskUserQuestionRequest =
        activeMatchingRequest?.tool === 'AskUserQuestion' &&
        resolveAgentRequestKind({ toolName: activeMatchingRequest.tool, requestKind: activeMatchingRequest.kind }) === 'user_action';
    const canInteract =
        isRunning &&
        !isSubmitted &&
        !isSubmitting &&
        canApprovePermissions &&
        hasActiveAskUserQuestionRequest;
    const disabledMessage =
        interaction?.permissionDisabledReason === 'public'
            ? t('session.sharing.permissionApprovalsDisabledPublic')
            : interaction?.permissionDisabledReason === 'readOnly'
                ? t('session.sharing.permissionApprovalsDisabledReadOnly')
                : t('session.sharing.permissionApprovalsDisabledNotGranted');
    const attachedTerminalNotice = Boolean(
        declaredDialog?.terminalNotice
        && isRecord(normalizedInput?.happierDialog)
        && normalizedInput.happierDialog.mode === 'notice'
        && questions[0]?.options.length === 0,
    );
    const attachedTerminalSecondaryAction = declaredDialog?.terminalSecondaryAction;
    const canOpenAttachedTerminal = Boolean(
        sessionId && isRunning && canApprovePermissions && attachedSessionTerminal.available,
    );
    const attachedTerminalUnavailableMessage = resolveAttachedTerminalUnavailableMessage(
        attachedSessionTerminal.unavailableReason,
    );

    if (attachedTerminalNotice && tool.state !== 'completed') {
        const question = questions[0];
        return (
            <ToolSectionView>
                <View testID="ask-user-question" style={styles.container}>
                    <View style={styles.questionSection}>
                        <View style={styles.headerChip}>
                            <Text style={styles.headerText}>{question?.header}</Text>
                        </View>
                        <Text style={styles.questionText}>{question?.question}</Text>
                        {canOpenAttachedTerminal && attachedTerminalSecondaryAction ? (
                            <TouchableOpacity
                                testID="ask-user-question.open-attached-terminal"
                                accessibilityRole="button"
                                accessibilityLabel={t(attachedTerminalSecondaryAction!.labelKey)}
                                style={styles.optionButton}
                                onPress={attachedSessionTerminal.open}
                                activeOpacity={0.7}
                            >
                                <Icon name="terminal" size={20} color={theme.colors.text.secondary} />
                                <View style={styles.optionContent}>
                                    <Text style={styles.optionLabel}>{t(attachedTerminalSecondaryAction!.labelKey)}</Text>
                                    <Text style={styles.optionDescription}>{t(attachedTerminalSecondaryAction!.descriptionKey)}</Text>
                                </View>
                            </TouchableOpacity>
                        ) : !canApprovePermissions ? (
                            <Text style={styles.optionDescription}>{disabledMessage}</Text>
                        ) : attachedTerminalSecondaryAction && isRunning && attachedTerminalUnavailableMessage ? (
                            <Text
                                testID="ask-user-question.attached-terminal-unavailable"
                                style={styles.optionDescription}
                            >
                                {attachedTerminalUnavailableMessage}
                            </Text>
                        ) : null}
                    </View>
                </View>
            </ToolSectionView>
        );
    }

    // Check if all questions have at least one selection
    const allQuestionsAnswered = questions.every((_, qIndex) => {
        const q = questions[qIndex];
        if (!q.required) return true;
        const options = Array.isArray(q?.options) ? q.options : [];
        const freeform = resolveFreeformAnswer(q, qIndex, freeformAnswers);
        const hasTyped = freeform.value.length > 0 || Boolean(q.freeform?.allowEmpty);
        if (options.length === 0) {
            return hasTyped;
        }
        const selected = selections.get(qIndex);
        const hasSelection = Boolean(selected && selected.size > 0);
        return q.freeform ? (hasSelection || hasTyped) : hasSelection;
    });

    const handleOptionToggle = React.useCallback((questionIndex: number, optionIndex: number, multiSelect: boolean) => {
        if (!canInteract) return;

        setSelections(prev => {
            const newMap = new Map(prev);
            const currentSet = newMap.get(questionIndex) || new Set();

            if (multiSelect) {
                // Toggle for multi-select
                const newSet = new Set(currentSet);
                if (newSet.has(optionIndex)) {
                    newSet.delete(optionIndex);
                } else {
                    newSet.add(optionIndex);
                }
                newMap.set(questionIndex, newSet);
            } else {
                // Replace for single-select
                newMap.set(questionIndex, new Set([optionIndex]));
            }

            return newMap;
        });

        if (!multiSelect) {
            setFreeformAnswers((prev) => {
                if (!prev.has(questionIndex)) return prev;
                const next = new Map(prev);
                next.delete(questionIndex);
                return next;
            });
        }
    }, [canInteract]);

    const handleSubmit = React.useCallback(async () => {
        if (!sessionId || !allQuestionsAnswered || isSubmitting) return;

        const answers: Record<string, readonly string[]> = {};
        questions.forEach((q, qIndex) => {
            const options = Array.isArray(q.options) ? q.options : [];
            const freeform = resolveFreeformAnswer(q, qIndex, freeformAnswers);
            const includeEmptyTextAnswer = q.selection === 'text' && q.required && q.freeform?.allowEmpty === true;
            if (options.length === 0) {
                if (freeform.value.length > 0 || freeform.present || includeEmptyTextAnswer) {
                    answers[q.answerKey] = [freeform.value];
                }
                return;
            }

            const selectedAnswerValues = Array.from(selections.get(qIndex) ?? [])
                .map(optIndex => options[optIndex])
                .filter((option): option is QuestionOption => Boolean(option))
                .map(option => option.answerValue);
            if (q.selection === 'multiple') {
                const exactValues = freeform.value.length > 0
                    ? [...selectedAnswerValues, freeform.value]
                    : selectedAnswerValues;
                if (exactValues.length > 0) answers[q.answerKey] = exactValues;
                return;
            }
            if (freeform.value.length > 0) {
                answers[q.answerKey] = [freeform.value];
            } else if (selectedAnswerValues.length > 0) {
                answers[q.answerKey] = selectedAnswerValues;
            }
        });

        try {
            if (!toolCallId) {
                Modal.alert(t('common.error'), t('errors.missingPermissionId'));
                return;
            }

            const latestSession = storage.getState().sessions[sessionId];
            const latestRequest = (latestSession as any)?.agentState?.requests?.[toolCallId];
            const hasLiveMatchingRequest =
                latestRequest?.tool === 'AskUserQuestion' &&
                resolveAgentRequestKind({ toolName: latestRequest.tool, requestKind: latestRequest.kind }) === 'user_action';
            if (!hasLiveMatchingRequest) {
                return;
            }

            const selectedSettingMutationCandidates = [...selections].flatMap(([questionIndex, selectedIndexes]) => (
                [...selectedIndexes]
                    .map((optionIndex) => questions[questionIndex]?.options?.[optionIndex]?.settingMutation)
                    .filter((candidate): candidate is unknown => candidate !== undefined)
            ));
            const submittingDeclarationAuthority = declarationAuthorityRef.current;
            const declaredMutation = selectedSettingMutationCandidates.length === 1 && submittingDeclarationAuthority
                ? resolveDeclaredAskUserQuestionSettingMutation({
                    sessionId,
                    serverId: submittingDeclarationAuthority.serverId,
                    agentId: submittingDeclarationAuthority.agentId,
                    machineId: submittingDeclarationAuthority.machineId,
                    behavior: submittingDeclarationAuthority.agentId
                        ? getAgentBehavior(
                            submittingDeclarationAuthority.agentId,
                            submittingDeclarationAuthority.machineId,
                        )
                        : null,
                    daemonProjection: submittingDeclarationAuthority.daemonProjection,
                    projectionRevision: submittingDeclarationAuthority.projectionRevision,
                    dialog: input.happierDialog,
                    candidate: selectedSettingMutationCandidates[0],
                })
                : null;
            setIsSubmitting(true);

            await sessionAllowWithAnswers(sessionId, toolCallId, answers);
            // The requester has accepted this answer, so the interaction is
            // terminal here. Remembering the choice is a SEPARATE outcome: a
            // failed preference write must be reported as such and must never
            // re-offer submit for a request that has already been answered.
            setIsSubmitted(true);
            const currentSession = storage.getState().sessions[sessionId];
            const currentOwnerMetadata = currentSession ? readSessionOwnerMetadataView(currentSession) : null;
            const currentServerId = typeof currentSession?.serverId === 'string' ? currentSession.serverId.trim() : '';
            const currentAgentId = resolveAgentIdFromSessionMetadata(currentOwnerMetadata);
            const currentMachineId = resolveSessionMachineId(currentOwnerMetadata);
            if (
                declaredMutation
                && currentServerId === declaredMutation.serverId
                && currentAgentId === declaredMutation.agentId
                && currentMachineId === declaredMutation.machineId
            ) {
                try {
                    await persistDeclaredAskUserQuestionSetting({
                        ...declaredMutation,
                        resolveCurrentDeclaration: () => {
                            const currentAuthority = declarationAuthorityRef.current;
                            if (!currentAuthority) return null;
                            return resolveDeclaredAskUserQuestionSettingMutation({
                                sessionId,
                                serverId: currentAuthority.serverId,
                                agentId: currentAuthority.agentId,
                                machineId: currentAuthority.machineId,
                                behavior: currentAuthority.agentId
                                    ? getAgentBehavior(currentAuthority.agentId, currentAuthority.machineId)
                                    : null,
                                daemonProjection: currentAuthority.daemonProjection,
                                projectionRevision: currentAuthority.projectionRevision,
                                dialog: input.happierDialog,
                                candidate: selectedSettingMutationCandidates[0],
                            });
                        },
                    });
                } catch (preferenceError) {
                    Modal.alert(
                        t('common.error'),
                        preferenceError instanceof Error
                            ? preferenceError.message
                            : t('errors.failedToSendMessage'),
                    );
                }
            }
        } catch (error) {
            setIsSubmitted(false);
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.failedToSendMessage'));
        } finally {
            setIsSubmitting(false);
        }
    }, [
        sessionId,
        questions,
        selections,
        freeformAnswers,
        allQuestionsAnswered,
        input.happierDialog,
        isSubmitting,
        toolCallId,
    ]);

    // Show submitted state
    if (isSubmitted || tool.state === 'completed') {
        const answersFromResult = parseAskUserQuestionAnswersFromToolResult(tool.result);
        return (
            <ToolSectionView>
                <View
                    style={styles.submittedContainer}
                    accessibilityLiveRegion="polite"
                >
                    {questions.map((q, qIndex) => {
                        const selected = selections.get(qIndex);
                        const options = Array.isArray(q.options) ? q.options : [];
                        const freeform = resolveFreeformAnswer(q, qIndex, freeformAnswers);
                        const selectedLabels =
                            options.length === 0
                                ? (freeform.value.length > 0 || freeform.present
                                    ? freeform.value
                                    : (answersFromResult?.[q.answerKey] ?? '-'))
                                : (q.selection === 'multiple' && (selected?.size || freeform.value.length > 0)
                                    ? [
                                        ...Array.from(selected ?? [])
                                            .map(optIndex => options[optIndex]?.label)
                                            .filter((label): label is string => Boolean(label)),
                                        ...(freeform.value.length > 0 ? [freeform.value] : []),
                                    ].join(', ')
                                    : freeform.value.length > 0
                                    ? freeform.value
                                    : (selected && selected.size > 0
                                        ? Array.from(selected)
                                            .map(optIndex => options[optIndex]?.label)
                                            .filter(Boolean)
                                            .join(', ')
                                        : (answersFromResult?.[q.answerKey] ?? '-')));
                        return (
                            <View key={`${q.answerKey}:${qIndex}`} style={styles.submittedItem}>
                                <Text style={styles.submittedHeader}>{q.header ?? q.question}:</Text>
                                <Text style={styles.submittedValue}>{selectedLabels}</Text>
                            </View>
                        );
                    })}
                </View>
            </ToolSectionView>
        );
    }

    return (
        <ToolSectionView>
            <View testID="ask-user-question" style={styles.container}>
                {input.title ? (
                    <View style={styles.headerChip}>
                        <Text style={styles.headerText}>{input.title}</Text>
                    </View>
                ) : null}
                {!canApprovePermissions && isRunning ? (
                    <Text style={{ color: theme.colors.text.secondary }}>
                        {disabledMessage}
                    </Text>
                ) : null}
                {attachedTerminalSecondaryAction && canOpenAttachedTerminal ? (
                    <TouchableOpacity
                        testID="ask-user-question.open-attached-terminal"
                        accessibilityRole="button"
                        accessibilityLabel={t(attachedTerminalSecondaryAction.labelKey)}
                        style={styles.optionButton}
                        onPress={attachedSessionTerminal.open}
                        activeOpacity={0.7}
                    >
                        <Icon name="terminal" size={20} color={theme.colors.text.secondary} />
                        <View style={styles.optionContent}>
                            <Text style={styles.optionLabel}>{t(attachedTerminalSecondaryAction.labelKey)}</Text>
                            <Text style={styles.optionDescription}>{t(attachedTerminalSecondaryAction.descriptionKey)}</Text>
                        </View>
                    </TouchableOpacity>
                ) : attachedTerminalSecondaryAction && isRunning && canApprovePermissions && attachedTerminalUnavailableMessage ? (
                    <Text
                        testID="ask-user-question.attached-terminal-unavailable"
                        style={styles.optionDescription}
                    >
                        {attachedTerminalUnavailableMessage}
                    </Text>
                ) : null}
                {questions.map((question, qIndex) => {
                    const selectedOptions = selections.get(qIndex) || new Set();
                    const options = Array.isArray(question.options) ? question.options : [];

                    return (
                        <View key={`${question.answerKey}:${qIndex}`} style={styles.questionSection}>
                            {question.header ? (
                                <View style={styles.headerChip}>
                                    <Text style={styles.headerText}>{question.header}</Text>
                                </View>
                            ) : null}
                            <Text style={styles.questionText}>{question.question}</Text>
                            <View style={styles.optionsContainer}>
                                {options.length === 0 || question.freeform ? (
                                    <View>
                                        <TextInput
                                            testID={`ask-user-question.freeform:${qIndex}`}
                                            style={styles.freeformInput}
                                            value={freeformAnswers.get(qIndex) ?? question.freeform?.initialValue ?? ''}
                                            onChangeText={(text) => {
                                                if (!canInteract) return;
                                                setFreeformAnswers((prev) => {
                                                    const next = new Map(prev);
                                                    next.set(qIndex, text);
                                                    return next;
                                                });
                                                const normalizedText = question.freeform?.whitespace === 'preserve'
                                                    ? text
                                                    : text.trim();
                                                if (options.length > 0 && !question.multiSelect && normalizedText.length > 0) {
                                                    setSelections((prev) => {
                                                        if (!prev.has(qIndex)) return prev;
                                                        const next = new Map(prev);
                                                        next.delete(qIndex);
                                                        return next;
                                                    });
                                                }
                                            }}
                                            onTouchStart={(event) => event.stopPropagation()}
                                            placeholder={question.freeform?.placeholder ?? t('tools.askUserQuestion.otherPlaceholder')}
                                            placeholderTextColor={theme.colors.text.secondary}
                                            multiline={question.freeform?.inputMode === 'multiLine'}
                                            editable={canInteract}
                                            accessibilityLabel={question.question}
                                            accessibilityHint={question.freeform?.description}
                                            accessibilityState={{ disabled: !canInteract }}
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                        />
                                        {question.freeform?.description ? (
                                            <Text style={styles.freeformDescription}>{question.freeform.description}</Text>
                                        ) : null}
                                    </View>
                                ) : null}
                                {options.map((option, oIndex) => {
                                    const isSelected = selectedOptions.has(oIndex);
                                    const testID = `ask-user-question.option:${qIndex}:${oIndex}`;

                                    return (
                                        <TouchableOpacity
                                            key={oIndex}
                                            testID={testID}
                                            accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'}
                                            accessibilityLabel={option.label}
                                            accessibilityState={{
                                                checked: isSelected,
                                                disabled: !canInteract,
                                            }}
                                            style={[
                                                styles.optionButton,
                                                isSelected && styles.optionButtonSelected,
                                                !canInteract && styles.optionButtonDisabled,
                                            ]}
                                            onPress={() => handleOptionToggle(qIndex, oIndex, question.multiSelect)}
                                            disabled={!canInteract}
                                            activeOpacity={0.7}
                                        >
                                            {question.multiSelect ? (
                                                <View style={[
                                                    styles.checkboxOuter,
                                                    isSelected && styles.checkboxOuterSelected,
                                                ]}>
                                                    {isSelected && (
                                                        <Icon name="check" size={14} color={theme.colors.button.primary.tint} />
                                                    )}
                                                </View>
                                            ) : (
                                                <View style={[
                                                    styles.radioOuter,
                                                    isSelected && styles.radioOuterSelected,
                                                ]}>
                                                    {isSelected && <View style={styles.radioInner} />}
                                                </View>
                                            )}
                                            <View style={styles.optionContent}>
                                                <Text style={styles.optionLabel}>{option.label}</Text>
                                                {option.description && (
                                                    <Text style={styles.optionDescription}>{option.description}</Text>
                                                )}
                                            </View>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        </View>
                    );
                })}

                {(canInteract || isSubmitting) && (
                    <View style={styles.actionsContainer}>
                        <TouchableOpacity
                            testID="ask-user-question.submit"
                            accessibilityRole="button"
                            accessibilityLabel={t('tools.askUserQuestion.submit')}
                            accessibilityState={{
                                disabled: !allQuestionsAnswered || isSubmitting,
                                busy: isSubmitting,
                            }}
                            style={[
                                styles.submitButton,
                                (!allQuestionsAnswered || isSubmitting) && styles.submitButtonDisabled,
                            ]}
                            onPress={handleSubmit}
                            disabled={!allQuestionsAnswered || isSubmitting}
                            activeOpacity={0.7}
                        >
                            {isSubmitting ? (
                                <ActivitySpinner size="small" color={theme.colors.button.primary.tint} />
                            ) : (
                                <Text style={styles.submitButtonText}>{t('tools.askUserQuestion.submit')}</Text>
                            )}
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        </ToolSectionView>
    );
});
