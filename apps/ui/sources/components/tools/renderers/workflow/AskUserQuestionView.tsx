import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from '../core/_registry';
import { resolvePermissionRequestId } from '../core/resolvePermissionRequestId';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { Modal } from '@/modal';
import { t } from '@/text';
import { Text, TextInput } from '@/components/ui/text/Text';
import { buildAgentRequestSemanticSummary } from '@happier-dev/protocol/activity/agentRequestSummary';
import { isStructuredQuestionSelectionCountValid, type StructuredQuestionAnswerDetailsV1 } from '@happier-dev/protocol/tools/structuredQuestionAnswersV1';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    useOpenAttachedSessionTerminal,
    resolveAttachedTerminalUnavailableMessage,
} from '@/components/sessions/terminal/openAttachedSessionTerminal';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { Icon } from '@/components/ui/icons/Icon';
import { getAgentBehavior } from '@/agents/catalog/catalog';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { AGENT_SCOPED_PLUGIN_SETTINGS_SECTIONS } from '@/agents/registry/agentScopedPluginSettingsDeclarations';
import type { PluginProjectionEditableSettingField } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { matchesQuestionFormRequest, PresentedQuestionRequest, useQuestionForm } from './useQuestionForm';
import { ReadyQuestionEntry, useGroupedQuestion, type GroupedQuestionResult } from './QuestionSendGroup';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { getMachineContributionRegistryProjectionRevision } from '@/sync/ops/machineContributionRegistryProjection';
import { projectScopedPluginSettingsField } from '@/sync/domains/plugins/settings/scopedPluginSettingsProjection';
import {
    persistDeclaredAskUserQuestionSetting,
    type DeclaredAskUserQuestionSettingMutation,
} from '@/sync/domains/plugins/settings/askUserQuestionSettings';
import { resolvePermissionDisabledMessage } from '@/components/tools/shell/permissions/permissionDisabledMessage';
import { usePendingPromptPrimaryFocus, markTranscriptPromptAnswered } from '@/components/tools/shell/permissions/usePendingPromptPrimaryFocus';
import { PermissionDecisionButton } from '@/components/tools/shell/permissions/PermissionDecisionButton';
import { PermissionAnswerUnconfirmedNotice } from '@/components/tools/shell/permissions/PermissionAnswerUnconfirmedNotice';
import {
    clearPermissionAnswerUnconfirmed,
    markPermissionAnswerUnconfirmed,
    permissionAnswerRequestKey,
    readPermissionActionDisposition,
    usePermissionAnswerUnconfirmed,
} from '@/components/tools/shell/permissions/permissionActionFailure';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { ToolFindText } from '../core/ToolFindText';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SaveMemoryDecisionSheet } from '@/components/memory/SaveMemoryDecisionSheet';
import type { SaveMemoryDecisionSeed } from '@/components/memory/memoryDecisionSeed';
import { readAnsweringClientCategory } from '@/sync/ops/sessions';
import { resolveAskUserQuestionFooterHint, resolveAskUserQuestionLead, type AskUserQuestionFooterHint, type AskUserQuestionLead } from './askUserQuestionCardState';
import { useAskUserQuestionAnsweredByLabel, useAskUserQuestionHandler } from './useAskUserQuestionHandler';


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
    canonical: boolean;
    answerKey: string;
    question: string;
    header?: string;
    options: QuestionOption[];
    multiSelect: boolean;
    required: boolean;
    selection: 'text' | 'single' | 'multiple';
    minSelections?: number;
    maxSelections?: number;
    allowNote?: boolean;
    freeform?: QuestionFreeform;
}

interface AskUserQuestionInput {
    title?: string;
    questions: Question[];
    happierDialog?: unknown;
}

type AskUserQuestionDeclarationAuthority = Readonly<{
    accountScope: ServerAccountScope | null | undefined;
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
        || candidate.settingId !== declaredMutation.settingId.localId
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
            .filter((field) => field.key === candidate.settingId && group.scope.kind === declaredMutation.settingId.scope)
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
            canonical: true,
            answerKey: value.id,
            question: value.question,
            ...(value.allowNote === true ? { allowNote: true } : {}),
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
    const summary = buildAgentRequestSemanticSummary({
        kind: 'user_action', toolName: 'AskUserQuestion', toolInput: { questions: [value] },
    }).questions[0];
    if (!summary || (summary.minSelections !== undefined && summary.minSelections > options.length)) return null;
    return {
        canonical: true,
        answerKey: value.id,
        question: value.question,
        options: options as QuestionOption[],
        multiSelect: value.selection === 'multiple',
        required: value.required === true,
        selection: value.selection,
        ...(summary.minSelections === undefined ? {} : { minSelections: summary.minSelections }),
        ...(summary.maxSelections === undefined ? {} : { maxSelections: summary.maxSelections }),
        ...(summary.allowNote === undefined ? {} : { allowNote: summary.allowNote }),
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
    const answerKey = buildAgentRequestSemanticSummary({
        kind: 'user_action', toolName: 'AskUserQuestion', toolInput: { questions: [value] },
    }).questions[0]?.answerKey;
    if (!answerKey) return null;
    const options = Array.isArray(value.options)
        ? value.options.map((option) => normalizeQuestionOption(option, false))
        : [];
    if (options.some((option) => option === null)) return null;
    const freeform = isRecord(value.freeform) ? value.freeform : null;
    return {
        canonical: false,
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

function readAskUserQuestionResult(result: unknown): Record<string, unknown> | null {
    let parsedResult = result;
    if (typeof parsedResult === 'string') {
        try {
            parsedResult = JSON.parse(parsedResult) as unknown;
        } catch {
            return null;
        }
    }
    return isRecord(parsedResult) ? parsedResult : null;
}

function isDismissedQuestion(tool: ToolViewProps['tool']): boolean {
    return tool.permission?.status === 'denied'
        || (tool.state === 'completed' && readAskUserQuestionResult(tool.result)?.status === 'declined');
}

function reportQuestionResponseFailure(error: unknown, requestKey: string): void {
    if (readPermissionActionDisposition(error) === 'outcomeUnknown') {
        markPermissionAnswerUnconfirmed(requestKey, error);
    } else {
        Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.failedToSendMessage'));
    }
}

function parseAskUserQuestionAnswersFromToolResult(result: unknown): Record<string, string> | null {
    const maybeAnswers = readAskUserQuestionResult(result)?.answers;
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

export const projectAskUserQuestionDisplayText: ToolDisplayTextProjector = (tool, metadata, context) => {
    const normalized = normalizeAskUserQuestionInput(tool.input);
    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    const behavior = agentId ? getAgentBehavior(agentId, resolveSessionMachineId(metadata), context?.accountScope) : null;
    const input = applyDeclaredTerminalNoticePresentation(normalized, normalized?.happierDialog,
        resolveDeclaredAskUserQuestionDialog(behavior, normalized?.happierDialog));
    if (!input) return [];
    const answers = parseAskUserQuestionAnswersFromToolResult(tool.result);
    if (isDismissedQuestion(tool)) return input.questions.flatMap((question, index) =>
        toolTextBlock(`tool-question-${index}-prompt`, question.question));
    if (tool.state === 'completed') return input.questions.flatMap((question, index) => [
        ...toolTextBlock(`tool-question-${index}-answer-label`, `${question.header ?? question.question}:`),
        ...toolTextBlock(`tool-question-${index}-answer`, answers?.[question.answerKey] ?? '-'),
    ]);
    const declaration = resolveDeclaredAskUserQuestionDialog(behavior, normalized?.happierDialog);
    if (declaration?.terminalNotice && isRecord(normalized?.happierDialog) && normalized.happierDialog.mode === 'notice'
        && input.questions[0]?.options.length === 0) {
        const question = input.questions[0];
        return [
            ...toolTextBlock('tool-question-0-header', question.header),
            ...toolTextBlock('tool-question-0-prompt', question.question),
        ];
    }
    return [
        ...toolTextBlock('tool-question-title', input.title),
        ...input.questions.flatMap((question, index) => [
            ...toolTextBlock(`tool-question-${index}-header`, question.header),
            ...toolTextBlock(`tool-question-${index}-prompt`, question.question),
            ...toolTextBlock(`tool-question-${index}-freeform-description`, question.freeform?.description),
            ...question.options.flatMap((option, optionIndex) => [
                ...toolTextBlock(`tool-question-${index}-option-${optionIndex}-label`, option.label),
                ...toolTextBlock(`tool-question-${index}-option-${optionIndex}-description`, option.description),
            ]),
        ]),
    ];
};

function formatFooterHint(hint: AskUserQuestionFooterHint): string {
    if (hint.kind === 'progress') return t('tools.askUserQuestion.progress', { answered: hint.answered, total: hint.total });
    return hint.kind === 'next_step' ? t('tools.askUserQuestion.hintNextStep') : t('tools.askUserQuestion.hintNextTurn');
}

/** The one line above the questions: who is handling it, or the assumption a non-blocking ask acts on. */
function AskUserQuestionLeadLine(props: Readonly<{ lead: AskUserQuestionLead }>) {
    const { lead } = props;
    if (lead.kind === 'not_blocking') {
        return (
            <Text testID="ask-user-question.lead" style={styles.leadText}>
                <Text style={styles.leadEmphasis}>{t('tools.askUserQuestion.notBlocking')}</Text>
                {` · ${lead.assumption}`}
            </Text>
        );
    }
    const text = lead.away === 'offline' ? t('tools.askUserQuestion.handlerOffline', { name: lead.name })
        : lead.away === 'stopped' ? t('tools.askUserQuestion.handlerStopped', { name: lead.name })
        : t('tools.askUserQuestion.handledBy', { name: lead.name });
    return <Text testID="ask-user-question.lead" style={[styles.leadText, lead.away ? styles.leadAttention : null]}>{text}</Text>;
}

// Styles MUST be defined outside the component to prevent infinite re-renders
// with react-native-unistyles. The theme is passed as a function parameter.
const styles = StyleSheet.create((theme) => ({
    container: {
        gap: theme.space.s16,
    },
    questionSection: {
        gap: theme.space.s8,
    },
    headerChip: {
        alignSelf: 'flex-start',
    },
    headerText: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    questionText: {
        fontSize: 15,
        fontWeight: '500',
        color: theme.colors.text.primary,
        marginBottom: theme.space.s8,
    },
    optionsContainer: {
        gap: theme.space.s4,
    },
    optionButton: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingVertical: theme.space.s12,
        paddingHorizontal: theme.space.s12,
        borderRadius: 8,
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        gap: theme.space.s10,
        // Lab `.q-opt`: a choice row is designed 44 tall (min-height), not a target-derived floor.
        minHeight: 44,
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
        marginTop: theme.space.s2,
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
        marginTop: theme.space.s2,
    },
    checkboxOuterSelected: {
        borderColor: theme.colors.radio.active,
        backgroundColor: theme.colors.radio.active,
    },
    optionContent: {
        flex: 1,
    },
    optionLabel: {
        ...Typography.variant('label'),
        color: theme.colors.text.primary,
    },
    optionDescription: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        marginTop: theme.space.s2,
    },
    freeformInput: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 8,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s12,
        fontSize: 14,
        color: theme.colors.text.primary,
        backgroundColor: theme.colors.surface.base,
        // Lab `.q-field` (coordination-v3 c3-q.css): the field is 40 tall, a touch target is its hit area.
        minHeight: 40,
    },
    freeformDescription: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        marginTop: theme.space.s6,
        marginLeft: theme.space.s2,
    },
    footer: {
        gap: theme.space.s12,
        marginTop: theme.space.s4,
        paddingTop: theme.space.s12,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    footerActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s12,
    },
    submitButtonTrailing: {
        marginLeft: 'auto',
    },
    footerHint: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    leadText: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
    leadEmphasis: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
    leadAttention: {
        color: theme.colors.state.attention.textForeground,
    },
    stateHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    stateTitle: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
    stateByline: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    withdrawnQuestion: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
    answerGrid: {
        gap: theme.space.s6,
    },
    submitButton: {
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: theme.space.s20,
        paddingVertical: theme.space.s6,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space.s6,
        // The shared control height (lab `.uw-btn`); the touch target is the hit area, not this box.
        minHeight: HAPPIER_PAGE_METRICS.controlHeightPx,
    },
    submitButtonQuiet: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    submitButtonDisabled: {
        opacity: 0.5,
    },
    submitButtonText: {
        color: theme.colors.button.primary.tint,
        ...Typography.variant('label', 'semiBold'),
    },
    submitButtonTextQuiet: {
        color: theme.colors.text.primary,
    },
    submittedContainer: {
        gap: theme.space.s8,
    },
    submittedItem: {
        flexDirection: 'row',
        gap: theme.space.s16,
    },
    submittedHeader: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        flexBasis: '32%',
        flexShrink: 0,
    },
    submittedValue: {
        ...Typography.variant('body'),
        color: theme.colors.text.primary,
        flex: 1,
    },
}));

/** The name a question's controls carry, so each answer is reachable with its question. */
function resolveQuestionAccessibilityLabel(question: Question): string {
    return question.header ? `${question.header}: ${question.question}` : question.question;
}

export const AskUserQuestionView = React.memo<ToolViewProps>(({ tool, messageId, sessionId, serverId: explicitServerId, session: suppliedSession, interaction, executionRun }) => {
    const source = useSessionTranscriptSource();
    const sourceInteraction = source.useInteraction();
    const actions = source.actions;
    const agentState = source.useAgentState();
    const pendingRequests = source.usePendingRequests();
    const archivedAt = source.useArchivedAt?.();
    const ownerMetadata = source.useMetadata();
    const currentFacts = React.useRef({ pendingRequests, ownerMetadata });
    currentFacts.current = { pendingRequests, ownerMetadata };
    const { theme } = useUnistyles();

    // Parse input
    const rawInput = tool.input;
    const attachedSessionTerminal = useOpenAttachedSessionTerminal(sessionId ?? null, source.serverId, suppliedSession);
    const agentId = resolveAgentIdFromSessionMetadata(ownerMetadata);
    const machineId = resolveSessionMachineId(ownerMetadata);
    const serverId = source.serverId ?? '';
    const accountScopeResolution = useServerCredentialAccountScopeResolution(explicitServerId ?? source.serverId);
    const accountScope = explicitServerId === undefined ? undefined
        : accountScopeResolution.kind === 'bound' ? accountScopeResolution.scope : null;
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        // The declared setting mutation reads the Agent and its editable settings groups.
        sections: AGENT_SCOPED_PLUGIN_SETTINGS_SECTIONS,
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
        accountScope,
        serverId,
        agentId,
        machineId,
        daemonProjection,
        projectionRevision,
    };
    const agentBehavior = agentId ? getAgentBehavior(agentId, machineId, accountScope) : null;
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

    const isRunning = tool.state === 'running';
    // Agent questions are conversational Send authority; Execution Runs keep
    // their own responder contract rather than borrowing Session actions.
    const canApprovePermissions = executionRun !== undefined
        ? executionRun.respond !== undefined && interaction?.canApprovePermissions !== false
        : actions !== null && sourceInteraction.canSendMessages && interaction?.canSendMessages !== false
            && sourceInteraction.permissionDisabledReason !== 'inactive'
            && interaction?.permissionDisabledReason !== 'inactive';
    const toolCallId = resolvePermissionRequestId(tool);
    const presentedQuestion = React.useContext(PresentedQuestionRequest);
    const transcriptTurnId = tool.permission?.turnId;
    const request = executionRun === undefined
        ? pendingRequests.userActionRequests.find(request => request.id === toolCallId
            && (presentedQuestion ? matchesQuestionFormRequest(request, presentedQuestion)
                : transcriptTurnId === undefined || request.turnId === transcriptTurnId)) : undefined;
    // An answer whose result was lost may already be applied: the form is withheld until a re-read says otherwise.
    const answerRequestKey = permissionAnswerRequestKey({
        originId: executionRun === undefined ? `session:${sessionId ?? ''}` : `executionRun:${executionRun.executionRunId}`,
        serverId: source.serverId,
        permissionId: toolCallId ?? '',
        turnId: request?.turnId,
    });
    const answerUnconfirmed = usePermissionAnswerUnconfirmed(answerRequestKey) && isRunning;
    React.useEffect(() => {
        if (!isRunning) clearPermissionAnswerUnconfirmed(answerRequestKey);
    }, [isRunning, answerRequestKey]);
    const activeMatchingRequest = toolCallId ? agentState?.requests?.[toolCallId] : null;
    // An Execution Run's caller vouches for the request by supplying a
    // responder; an answer it still holds keeps the form withdrawn.
    const hasActiveAskUserQuestionRequest = executionRun !== undefined
        ? executionRun.respond !== undefined && toolCallId !== null && !executionRun.pendingRequestIds.has(toolCallId)
        : request !== undefined;
    const withdrawn = executionRun === undefined && isRunning && activeMatchingRequest != null
        && !hasActiveAskUserQuestionRequest;
    const eligible = isRunning && canApprovePermissions && hasActiveAskUserQuestionRequest;
    const { state: form, previousDraft, update: updateForm, canEdit, isEditor } = useQuestionForm(
        accountScopeResolution.kind === 'bound' ? accountScopeResolution.scope : null,
        sessionId, request, eligible,
    );
    const { selections, freeformAnswers, notes, busy: isSubmitting, outcome: submissionOutcome } = form;
    const grouped = useGroupedQuestion() && executionRun === undefined;
    const canInteract = eligible && canEdit && !submissionOutcome && !isSubmitting && !answerUnconfirmed;
    const primaryAnswerRef = usePendingPromptPrimaryFocus(toolCallId, executionRun === undefined && canInteract, messageId);
    const completedRequest = toolCallId ? agentState?.completedRequests?.[toolCallId] : null;
    const questionV1 = activeMatchingRequest?.questionV1 ?? completedRequest?.questionV1;
    const handler = useAskUserQuestionHandler(isRunning ? activeMatchingRequest?.currentHandler : undefined, source.serverId ?? null,
        isRunning && activeMatchingRequest?.questionV1 && sessionId
            ? { sessionId, questionV1: activeMatchingRequest.questionV1 } : undefined);
    const answeredByLabel = useAskUserQuestionAnsweredByLabel(tool.permission?.status === 'approved' ? tool.permission.answeredBy : undefined, source.serverId ?? null);
    const rememberAnchorRef = React.useRef<View>(null);
    const [rememberOpen, setRememberOpen] = React.useState(false);
    const [remembered, setRemembered] = React.useState(false);

    if (!input || !questions || !Array.isArray(questions) || questions.length === 0) {
        return null;
    }

    const disabledMessage =
        resolvePermissionDisabledMessage(interaction?.permissionDisabledReason ?? sourceInteraction.permissionDisabledReason);
    const attachedTerminalNotice = Boolean(
        declaredDialog?.terminalNotice
        && isRecord(normalizedInput?.happierDialog)
        && normalizedInput.happierDialog.mode === 'notice'
        && questions[0]?.options.length === 0,
    );
    const attachedTerminalSecondaryAction = declaredDialog?.terminalSecondaryAction;
    const canOpenAttachedTerminal = Boolean(
        source.navigate !== null && source.actions !== null && sessionId && isRunning && canApprovePermissions && attachedSessionTerminal.available,
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
                            <ToolFindText messageId={messageId} blockId="tool-question-0-header" text={question?.header ?? ''} style={styles.headerText} />
                        </View>
                        <ToolFindText messageId={messageId} blockId="tool-question-0-prompt" text={question?.question ?? ''} style={styles.questionText} />
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
        if (q.selection === 'multiple' && !isStructuredQuestionSelectionCountValid(q, selections.get(qIndex)?.size ?? 0)) return false;
        if (q.selection === 'multiple' && q.minSelections === 0) return true;
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
        if (!canInteract || !isEditor()) return;

        updateForm(current => {
            const selections = new Map(current.selections);
            const freeformAnswers = new Map(current.freeformAnswers);
            const currentSet = selections.get(questionIndex) ?? new Set<number>();

            if (multiSelect) {
                // Toggle for multi-select
                const newSet = new Set(currentSet);
                if (newSet.has(optionIndex)) {
                    newSet.delete(optionIndex);
                } else {
                    newSet.add(optionIndex);
                }
                selections.set(questionIndex, newSet);
            } else {
                // Replace for single-select
                selections.set(questionIndex, new Set([optionIndex]));
                freeformAnswers.delete(questionIndex);
            }
            return { ...current, selections, freeformAnswers };
        });
    }, [canInteract, isEditor, updateForm]);

    const handleSubmit = React.useCallback(async (): Promise<GroupedQuestionResult> => {
        if ((!sessionId && executionRun === undefined) || !canInteract || !allQuestionsAnswered || !isEditor()) return 'replaced';

        const answers: Record<string, readonly string[]> = {};
        const answerDetails: Record<string, StructuredQuestionAnswerDetailsV1[string]> = {};
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
                const exactValues = freeform.value.length > 0 && !q.canonical
                    ? [...selectedAnswerValues, freeform.value]
                    : selectedAnswerValues;
                if (exactValues.length > 0 || freeform.value.length > 0 || q.minSelections === 0) answers[q.answerKey] = exactValues;
                if (q.canonical && freeform.value.length > 0) answerDetails[q.answerKey] = { freeText: freeform.value };
                return;
            }
            if (freeform.value.length > 0) {
                answers[q.answerKey] = q.canonical ? [] : [freeform.value];
                if (q.canonical) answerDetails[q.answerKey] = { freeText: freeform.value };
            } else if (selectedAnswerValues.length > 0) {
                answers[q.answerKey] = selectedAnswerValues;
            }
        });
        questions.forEach((q, qIndex) => {
            const note = q.canonical && q.allowNote ? (notes.get(qIndex) ?? '').trim() : '';
            if (note.length > 0) answerDetails[q.answerKey] = { ...answerDetails[q.answerKey], note };
        });

        try {
            if (!toolCallId) {
                Modal.alert(t('common.error'), t('errors.missingPermissionId'));
                return 'replaced';
            }

            if (executionRun !== undefined) {
                const respond = executionRun.respond;
                if (respond === undefined || executionRun.pendingRequestIds.has(toolCallId)) return 'replaced';
                updateForm(current => ({ ...current, busy: true }));
                await respond({ requestId: toolCallId, answers,
                    ...(Object.keys(answerDetails).length > 0 ? { answerDetails } : {}) });
                updateForm(current => ({ ...current, outcome: 'answered' }));
                return 'sent';
            }
            if (!sessionId || !actions) return 'replaced';

            if (!request || !currentFacts.current.pendingRequests.userActionRequests.some(current => matchesQuestionFormRequest(current, request))) {
                return 'replaced';
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
                            submittingDeclarationAuthority.accountScope,
                        )
                        : null,
                    daemonProjection: submittingDeclarationAuthority.daemonProjection,
                    projectionRevision: submittingDeclarationAuthority.projectionRevision,
                    dialog: input.happierDialog,
                    candidate: selectedSettingMutationCandidates[0],
                })
                : null;
            updateForm(current => ({ ...current, busy: true }));

            await actions.answerUserAction({ id: toolCallId, answers,
                ...(request.turnId ? { turnId: request.turnId } : {}),
                ...(Object.keys(answerDetails).length > 0 ? { answerDetails } : {}) });
            markTranscriptPromptAnswered(source, toolCallId);
            // The requester has accepted this answer, so the interaction is
            // terminal here. Remembering the choice is a SEPARATE outcome: a
            // failed preference write must be reported as such and must never
            // re-offer submit for a request that has already been answered.
            updateForm(current => ({ ...current, outcome: 'answered' }));
            const currentOwnerMetadata = currentFacts.current.ownerMetadata;
            const currentServerId = source.serverId ?? '';
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
                                    ? getAgentBehavior(currentAuthority.agentId, currentAuthority.machineId, currentAuthority.accountScope)
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
            return 'sent';
        } catch (error) {
            if (readPermissionActionDisposition(error) === 'outcomeUnknown') {
                markPermissionAnswerUnconfirmed(answerRequestKey, error);
                return 'unconfirmed';
            }
            if (!grouped) reportQuestionResponseFailure(error, answerRequestKey);
            if (isRecord(error) && error.code === 'permission_request_not_found') return 'replaced';
            return { failure: error instanceof Error ? error.message : t('errors.failedToSendMessage') };
        } finally {
            updateForm(current => ({ ...current, busy: false }));
        }
    }, [
        sessionId,
        executionRun,
        source,
        actions,
        canInteract,
        explicitServerId,
        suppliedSession,
        questions,
        selections,
        freeformAnswers,
        notes,
        allQuestionsAnswered,
        input.happierDialog,
        toolCallId,
        answerRequestKey,
        request,
        isEditor,
        updateForm,
        grouped,
    ]);

    const handleDismiss = React.useCallback(async () => {
        if (!toolCallId || !canInteract || !isEditor()) return;
        const respond = (() => {
            if (executionRun !== undefined) {
                const send = executionRun.respond;
                if (!send || executionRun.pendingRequestIds.has(toolCallId)) return null;
                return () => send({ requestId: toolCallId, approved: false });
            }
            if (!sessionId || !actions || !request || !currentFacts.current.pendingRequests.userActionRequests.some(current => matchesQuestionFormRequest(current, request))) return null;
            return () => actions.answerUserAction({ id: toolCallId, decision: 'reject', ...(request.turnId ? { turnId: request.turnId } : {}) });
        })();
        if (!respond) return;
        updateForm(current => ({ ...current, busy: true }));
        try {
            await respond();
            if (executionRun === undefined) markTranscriptPromptAnswered(source, toolCallId);
            updateForm(current => ({ ...current, outcome: 'dismissed' }));
        } catch (error) {
            reportQuestionResponseFailure(error, answerRequestKey);
        } finally {
            updateForm(current => ({ ...current, busy: false }));
        }
    }, [sessionId, toolCallId, actions, executionRun, canInteract, source, answerRequestKey, request, isEditor, updateForm]);

    // The asker withdrew it: the reason replaces the form; nothing is left to answer.
    if (!submissionOutcome && (tool.permission?.status === 'canceled' || withdrawn)) {
        const reason = tool.permission?.status === 'canceled'
            ? tool.permission.reason
            : archivedAt != null ? t('workflows.events.sessionArchived') : null;
        return (
            <ToolSectionView>
                <View testID="ask-user-question.withdrawn" style={styles.submittedContainer}>
                    <View style={styles.stateHeader}>
                        <Text style={styles.stateTitle}>{t('tools.askUserQuestion.withdrawn')}</Text>
                        {reason ? <Text style={styles.stateByline} numberOfLines={1}>{` · ${reason}`}</Text> : null}
                    </View>
                    {questions.map((q, qIndex) => (
                        <ToolFindText key={`${q.answerKey}:${qIndex}`} messageId={messageId} blockId={`tool-question-${qIndex}-prompt`} text={q.question} style={styles.withdrawnQuestion} />
                    ))}
                </View>
            </ToolSectionView>
        );
    }

    if (submissionOutcome === 'dismissed' || isDismissedQuestion(tool)) {
        return (
            <ToolSectionView>
                <View testID="ask-user-question.dismissed" style={styles.submittedContainer}>
                    <Text style={styles.stateTitle}>{t('tools.askUserQuestion.dismissed')}</Text>
                    {questions.map((q, qIndex) => (
                        <ToolFindText key={`${q.answerKey}:${qIndex}`} messageId={messageId} blockId={`tool-question-${qIndex}-prompt`} text={q.question} style={styles.withdrawnQuestion} />
                    ))}
                </View>
            </ToolSectionView>
        );
    }

    // Show submitted state
    if (submissionOutcome === 'answered' || tool.state === 'completed') {
        const answersFromResult = parseAskUserQuestionAnswersFromToolResult(tool.result);
        const answerRows = questions.map((q, qIndex) => {
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
            const firstSelectedDescription = selected && selected.size > 0
                ? options[Array.from(selected)[0]!]?.description : undefined;
            return { key: `${q.answerKey}:${qIndex}`, qIndex, label: q.header ?? q.question, value: selectedLabels, reason: firstSelectedDescription };
        });
        const thisClient = readAnsweringClientCategory();
        const answeredElsewhere = submissionOutcome !== 'answered' && completedRequest?.answeringClientCategory !== undefined
            && thisClient !== undefined && completedRequest.answeringClientCategory !== thisClient;
        const canRemember = questionV1?.lasting === true && Boolean(messageId && sessionId && source.serverId);
        const rememberSeed: SaveMemoryDecisionSeed | null = canRemember && messageId && sessionId && source.serverId ? {
            sourceMessageRef: { kind: 'session', session: { serverId: source.serverId, sessionId }, messageId },
            text: answerRows.map((row) => answerRows.length > 1 ? `${row.label}: ${row.value}` : row.value).join('; '),
            reason: answerRows.find((row) => row.reason)?.reason ?? '',
        } : null;
        return (
            <ToolSectionView>
                <View
                    style={styles.submittedContainer}
                    accessibilityLiveRegion="polite"
                >
                    <View style={styles.stateHeader}>
                        <Icon name="check" size={16} color={theme.colors.text.secondary} />
                        <Text style={styles.stateTitle}>{answeredByLabel ?? t('tools.askUserQuestion.answered')}</Text>
                        {answeredElsewhere ? <Text style={styles.stateByline}>{` · ${t('tools.askUserQuestion.answeredElsewhere')}`}</Text> : null}
                    </View>
                    <View style={styles.answerGrid}>
                        {answerRows.map((row) => (
                            <View key={row.key} style={styles.submittedItem}>
                                <ToolFindText messageId={messageId} blockId={`tool-question-${row.qIndex}-answer-label`} text={row.label} style={styles.submittedHeader} />
                                <ToolFindText messageId={messageId} blockId={`tool-question-${row.qIndex}-answer`} text={row.value} style={styles.submittedValue} />
                            </View>
                        ))}
                    </View>
                    {rememberSeed ? (
                        <View style={styles.footer}>
                            <Text style={styles.footerHint}>{t('tools.askUserQuestion.lasting')}</Text>
                            <View ref={rememberAnchorRef} collapsable={false}>
                                <RoundButton
                                    testID="ask-user-question.remember"
                                    size="small"
                                    display="secondary"
                                    title={remembered ? t('tools.askUserQuestion.remembered') : t('tools.askUserQuestion.rememberThis')}
                                    disabled={remembered}
                                    onPress={() => setRememberOpen(true)}
                                />
                            </View>
                        </View>
                    ) : null}
                    {rememberOpen && rememberSeed ? (
                        <SaveMemoryDecisionSheet
                            seed={rememberSeed}
                            anchorRef={rememberAnchorRef}
                            onClose={() => setRememberOpen(false)}
                            onSaved={() => { setRememberOpen(false); setRemembered(true); }}
                        />
                    ) : null}
                </View>
            </ToolSectionView>
        );
    }

    const lead = resolveAskUserQuestionLead({ questionV1, handler });
    const answeredCount = questions.filter((q, qIndex) => {
        const freeform = resolveFreeformAnswer(q, qIndex, freeformAnswers);
        return freeform.value.length > 0 || Boolean(selections.get(qIndex)?.size);
    }).length;
    const footerHint = resolveAskUserQuestionFooterHint({ mode: questionV1?.mode, total: questions.length, answered: answeredCount });

    return (
        <ToolSectionView>
            <View testID="ask-user-question" style={styles.container}>
                {input.title ? (
                    <View style={styles.headerChip}>
                        <ToolFindText messageId={messageId} blockId="tool-question-title" text={input.title} style={styles.headerText} />
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
                {lead ? <AskUserQuestionLeadLine lead={lead} /> : null}
                {canInteract && !previousDraft.outcome && (previousDraft.freeformAnswers.size + previousDraft.notes.size > 0) ? (
                    <View testID="ask-user-question.previous-draft">
                        <Text style={styles.stateTitle}>{t('sessionWork.questions.previousDraft')}</Text>
                        {[...previousDraft.freeformAnswers.values(), ...previousDraft.notes.values()].map((text, index) => (
                            <Text key={index} selectable style={styles.withdrawnQuestion}>{text}</Text>
                        ))}
                    </View>
                ) : null}
                {grouped && request ? <ReadyQuestionEntry ready={canInteract && allQuestionsAnswered}
                    question={{ id: JSON.stringify([source.serverId, sessionId, request.id, request.turnId, request.createdAt]),
                        label: questions[0]?.question ?? '', send: handleSubmit }} /> : null}
                {questions.map((question, qIndex) => {
                    const selectedOptions = selections.get(qIndex) || new Set();
                    const options = Array.isArray(question.options) ? question.options : [];
                    const questionLabel = resolveQuestionAccessibilityLabel(question);

                    return (
                        <View
                            key={`${question.answerKey}:${qIndex}`}
                            testID={`ask-user-question.question:${qIndex}`}
                            style={styles.questionSection}
                            role={options.length > 0 && !question.multiSelect ? 'radiogroup' : 'group'}
                            accessibilityLabel={questionLabel}
                        >
                            {question.header ? (
                                <View style={styles.headerChip}>
                                    <ToolFindText messageId={messageId} blockId={`tool-question-${qIndex}-header`} text={question.header} style={styles.headerText} />
                                </View>
                            ) : null}
                            <ToolFindText messageId={messageId} blockId={`tool-question-${qIndex}-prompt`} text={question.question} style={styles.questionText} />
                            <View style={styles.optionsContainer}>
                                {options.length === 0 || question.freeform ? (
                                    <View>
                                        <TextInput
                                            testID={`ask-user-question.freeform:${qIndex}`}
                                            ref={qIndex === 0 && canInteract ? primaryAnswerRef : undefined}
                                            style={styles.freeformInput}
                                            value={freeformAnswers.get(qIndex) ?? question.freeform?.initialValue ?? ''}
                                            onChangeText={(text) => {
                                                if (!canInteract || !isEditor()) return;
                                                const normalizedText = question.freeform?.whitespace === 'preserve'
                                                    ? text
                                                    : text.trim();
                                                updateForm(current => {
                                                    const selections = new Map(current.selections);
                                                    if (options.length > 0 && !question.multiSelect && normalizedText.length > 0) selections.delete(qIndex);
                                                    return { ...current, selections, freeformAnswers: new Map(current.freeformAnswers).set(qIndex, text) };
                                                });
                                            }}
                                            onTouchStart={(event) => event.stopPropagation()}
                                            placeholder={question.freeform?.placeholder ?? t('tools.askUserQuestion.otherPlaceholder')}
                                            placeholderTextColor={theme.colors.text.secondary}
                                            multiline={question.freeform?.inputMode === 'multiLine'}
                                            editable={canInteract}
                                            accessibilityLabel={questionLabel}
                                            accessibilityHint={question.freeform?.description}
                                            accessibilityState={{ disabled: !canInteract }}
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                        />
                                        {question.freeform?.description ? (
                                            <ToolFindText messageId={messageId} blockId={`tool-question-${qIndex}-freeform-description`} text={question.freeform.description} style={styles.freeformDescription} />
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
                                            ref={qIndex === 0 && oIndex === 0 && !question.freeform && canInteract ? primaryAnswerRef : undefined}
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
                                                <ToolFindText messageId={messageId} blockId={`tool-question-${qIndex}-option-${oIndex}-label`} text={option.label} style={styles.optionLabel} />
                                                {option.description ? (
                                                    <ToolFindText messageId={messageId} blockId={`tool-question-${qIndex}-option-${oIndex}-description`} text={option.description} style={styles.optionDescription} />
                                                ) : null}
                                            </View>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                            {question.canonical && question.allowNote ? (
                                <TextInput
                                    testID={`ask-user-question.note:${qIndex}`}
                                    style={styles.freeformInput}
                                    value={notes.get(qIndex) ?? ''}
                                    onChangeText={(text) => {
                                        if (!canInteract || !isEditor()) return;
                                        updateForm(current => ({ ...current, notes: new Map(current.notes).set(qIndex, text) }));
                                    }}
                                    onTouchStart={(event) => event.stopPropagation()}
                                    placeholder={t('tools.askUserQuestion.notePlaceholder')}
                                    placeholderTextColor={theme.colors.text.secondary}
                                    multiline
                                    editable={canInteract}
                                    accessibilityLabel={t('tools.askUserQuestion.notePlaceholder')}
                                    accessibilityState={{ disabled: !canInteract }}
                                />
                            ) : null}
                        </View>
                    );
                })}

                {answerUnconfirmed ? (
                    <PermissionAnswerUnconfirmedNotice
                        requestKey={answerRequestKey}
                        requestId={toolCallId ?? ''}
                        actions={executionRun === undefined ? actions : null}
                        testIDPrefix="ask-user-question"
                    />
                ) : null}
                {(canInteract || isSubmitting || answerUnconfirmed) && (
                    <View style={styles.footer}>
                        <Text testID="ask-user-question.hint" style={styles.footerHint}>{formatFooterHint(footerHint)}</Text>
                        <View style={styles.footerActions}>
                            <PermissionDecisionButton
                                testID="ask-user-question.dismiss"
                                hitReach={theme.space.s12 / 2}
                                accessibilityRole="button"
                                accessibilityLabel={t('tools.askUserQuestion.dismiss')}
                                accessibilityState={{ disabled: isSubmitting || answerUnconfirmed, busy: isSubmitting }}
                                style={[styles.submitButton, styles.submitButtonQuiet, (isSubmitting || answerUnconfirmed) && styles.submitButtonDisabled]}
                                onPress={handleDismiss}
                                disabled={isSubmitting || answerUnconfirmed}
                                activeOpacity={0.7}
                            >
                                <Text style={[styles.submitButtonText, styles.submitButtonTextQuiet]}>{t('tools.askUserQuestion.dismiss')}</Text>
                            </PermissionDecisionButton>
                            {!grouped ? <PermissionDecisionButton
                                testID="ask-user-question.submit"
                                hitReach={theme.space.s12 / 2}
                                accessibilityRole="button"
                                accessibilityLabel={t('tools.askUserQuestion.submit')}
                                accessibilityState={{
                                    disabled: !allQuestionsAnswered || isSubmitting || answerUnconfirmed,
                                    busy: isSubmitting,
                                }}
                                style={[
                                    styles.submitButton,
                                    styles.submitButtonTrailing,
                                    questionV1?.mode === 'continue' && styles.submitButtonQuiet,
                                    (!allQuestionsAnswered || isSubmitting || answerUnconfirmed) && styles.submitButtonDisabled,
                                ]}
                                onPress={() => { void handleSubmit(); }}
                                disabled={!allQuestionsAnswered || isSubmitting || answerUnconfirmed}
                                activeOpacity={0.7}
                            >
                                {isSubmitting ? (
                                    <ActivitySpinner size="small" color={questionV1?.mode === 'continue' ? theme.colors.text.primary : theme.colors.button.primary.tint} />
                                ) : (
                                    <Text style={[styles.submitButtonText, questionV1?.mode === 'continue' && styles.submitButtonTextQuiet]}>{t('tools.askUserQuestion.submit')}</Text>
                                )}
                            </PermissionDecisionButton> : null}
                        </View>
                    </View>
                )}
            </View>
        </ToolSectionView>
    );
});
