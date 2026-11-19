import { z } from 'zod/mini';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { SessionAuthoringExecutionTargetV2Schema } from '@happier-dev/protocol/sessions/authoring/fieldCatalog';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { stripMarkdown } from '@happier-dev/protocol/messages/markdownPlainText';

import type { NewSessionDraftProjection } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { getSessionDraftDocumentFieldValue } from '@/sync/ops/sessionDrafts/sessionDraftDocumentFields';
import {
    resolveAgentIdFromFlavor,
    resolveBundledAgentIdFromContributionIdentity,
} from '@/agents/catalog/catalog';
import { t, type TranslationKey } from '@/text';
import { resolveSessionDraftStatusKey } from './sessionDraftStatusPresentation';

export type NewSessionDraftRowPresentation = Readonly<{
    title: string;
    statusKey: TranslationKey | null;
}>;

export type NewSessionDraftAvailabilitySummary = Readonly<{
    machineUnavailable: boolean;
    pluginUnavailable: boolean;
    attachmentNeedsAttention: boolean;
}>;

function readAuthoringValue(draft: Pick<NewSessionDraftProjection, 'document'>, fieldId: string): unknown {
    return getSessionDraftDocumentFieldValue(draft.document, { kind: 'authoring', fieldId });
}

function readNonblankString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

/**
 * What a New Session draft is and what it is called: a Bot draft or a Session draft, and the name a person gave it.
 * Its list row, the folded dock and every draft Action's confirmation read it here (QA-RERUN-1113 F5/F6), so a
 * draft never reads as a bot in one place and a New Session (or "Untitled draft") in another.
 */
export type NewSessionDraftIdentity = Readonly<{ isBot: boolean; name: string | null }>;

export function readNewSessionDraftIdentity(document: unknown): NewSessionDraftIdentity {
    const facts = document ? getSessionDraftDocumentFieldValue(document, { kind: 'authoring', fieldId: 'initialSessionFacts' }) : null;
    const name = document ? getSessionDraftDocumentFieldValue(document, { kind: 'authoring', fieldId: 'sessionName' }) : null;
    return { isBot: Boolean(facts && typeof facts === 'object' && 'bot' in facts && facts.bot), name: readNonblankString(name) };
}

function safeFinalPathSegment(value: unknown): string | null {
    const path = readNonblankString(value);
    if (!path) return null;
    const segments = path.replace(/[\\/]+$/g, '').split(/[\\/]+/);
    return readNonblankString(segments[segments.length - 1]);
}

function firstPromptLine(value: string): string | null {
    for (const line of value.split(/\r?\n/)) {
        const promptLine = readNonblankString(stripMarkdown(line));
        if (promptLine) return promptLine;
    }
    return null;
}

function readAutomationName(draft: Pick<NewSessionDraftProjection, 'document'>): string | null {
    const value = readAuthoringValue(draft, 'automation');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return readNonblankString((value as Readonly<Record<string, unknown>>).name);
}

/**
 * The Agent the draft is authored against, normalized to its bundled id when it
 * names one. An installed Agent keeps its own id, and a draft that names no
 * Agent resolves to none: the row shows no mark rather than the default Agent's.
 */
export function resolveNewSessionDraftAgentId(draft: NewSessionDraftProjection): string {
    if (!draft.readView) return '';
    if (draft.readView.documentVersion === 2) {
        const agentTarget = z.nullable(AgentExecutionTargetV1Schema).safeParse(
            readAuthoringValue(draft, 'agentTarget'),
        );
        if (agentTarget.success && agentTarget.data) {
            return resolveBundledAgentIdFromContributionIdentity(agentTarget.data.identity)
                ?? buildQualifiedPluginContributionKey(agentTarget.data.identity);
        }
        return '';
    }
    const authoredAgentId = readNonblankString(readAuthoringValue(draft, 'agentId'));
    return resolveAgentIdFromFlavor(authoredAgentId) ?? authoredAgentId ?? '';
}

/**
 * The exact Machine the draft targets, or none. The released document keeps the
 * flat `machineId` selection while the current document carries the catalogued
 * `executionTarget`; a Temporary computer names no Machine at all, so it stays
 * out of Machine availability and never reports an offline Machine.
 */
export function resolveNewSessionDraftMachineId(draft: NewSessionDraftProjection): string | null {
    if (!draft.readView) return null;
    if (draft.readView.documentVersion === 1) {
        return readNonblankString(readAuthoringValue(draft, 'machineId'));
    }
    const executionTarget = z.nullable(SessionAuthoringExecutionTargetV2Schema)
        .safeParse(readAuthoringValue(draft, 'executionTarget'));
    return executionTarget.success && executionTarget.data?.kind === 'machine'
        ? readNonblankString(executionTarget.data.target.machineId)
        : null;
}

function resolveStatusKey(
    draft: NewSessionDraftProjection,
    availability?: NewSessionDraftAvailabilitySummary,
): TranslationKey | null {
    if (draft.status === 'conflict' || draft.status === 'offline' || draft.status === 'error') {
        return resolveSessionDraftStatusKey(draft.status);
    }
    if (availability?.machineUnavailable) return 'sessionDrafts.availability.machineUnavailable';
    if (availability?.pluginUnavailable) return 'sessionDrafts.availability.pluginUnavailable';
    if (availability?.attachmentNeedsAttention) return 'sessionDrafts.availability.attachmentNeedsAttention';
    if (draft.status === 'pending') return resolveSessionDraftStatusKey(draft.status);
    return null;
}

export function buildNewSessionDraftTitle(
    draft: Pick<NewSessionDraftProjection, 'document'>,
    prompt: string,
): string {
    return readNewSessionDraftIdentity(draft.document).name ?? firstPromptLine(prompt) ?? readAutomationName(draft)
        ?? safeFinalPathSegment(readAuthoringValue(draft, 'directory')) ?? t('sessionDrafts.untitled');
}

export function buildNewSessionDraftRowPresentation(
    draft: NewSessionDraftProjection,
    availability?: NewSessionDraftAvailabilitySummary,
): NewSessionDraftRowPresentation {
    return {
        title: buildNewSessionDraftTitle(draft, draft.readView?.composer.text.value ?? ''),
        statusKey: resolveStatusKey(draft, availability),
    };
}
