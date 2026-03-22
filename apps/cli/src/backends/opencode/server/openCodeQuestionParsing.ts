import type { OpenCodeQuestionRequest } from './types';
import { asRecord, normalizeString } from './openCodeParsing';
import { looksLikeFreeformQuestionHintLabel, splitCommaSeparatedLabels } from '@/agent/questions/structuredQuestionAnswerText';

export { looksLikeFreeformQuestionHintLabel };

export function hasAnyMeaningfulInputFields(rawInput: unknown): boolean {
  if (rawInput == null) return false;
  if (typeof rawInput === 'string') return rawInput.trim().length > 0;
  if (Array.isArray(rawInput)) return rawInput.length > 0;
  const rec = asRecord(rawInput);
  if (!rec) return false;
  return Object.keys(rec).length > 0;
}

export function extractBashCommandHint(rawInput: unknown): string {
  const rec = asRecord(rawInput);
  if (!rec) return '';
  const command = normalizeString(rec.command);
  if (command) return command;
  const cmd = normalizeString(rec.cmd);
  if (cmd) return cmd;
  const argv = Array.isArray(rec.argv) ? rec.argv : Array.isArray(rec.items) ? rec.items : null;
  if (Array.isArray(argv) && argv.every((v) => typeof v === 'string')) {
    const joined = (argv as string[]).join(' ').trim();
    if (joined) return joined;
  }
  return '';
}

export function openCodeQuestionRecordLooksFreeform(q: Record<string, unknown>): boolean {
  const hasLocations = Array.isArray((q as any).locations);
  const multiple = (q as any).multiple === true;
  const rawOptions = Array.isArray(q.options) ? q.options : [];
  const optionLabels = rawOptions
    .map((opt) => (asRecord(opt) ?? null))
    .filter(Boolean)
    .map((opt) => normalizeString((opt as any).label))
    .filter((label) => label.trim().length > 0);

  if (hasLocations) return true;
  if (optionLabels.length === 0) return true;
  if (multiple) return false;
  if (optionLabels.length === 1 && looksLikeFreeformQuestionHintLabel(optionLabels[0]!)) return true;
  if (optionLabels.some(looksLikeFreeformQuestionHintLabel)) return true;
  return false;
}

export function openCodeQuestionRecordLooksLikeInternalTitleUpdate(q: Record<string, unknown>): boolean {
  const header = normalizeString(q.header).trim().toLowerCase();
  if (header !== 'title' && header !== 'title update') return false;
  const question = normalizeString(q.question).trim().toLowerCase();
  if (!question.startsWith('(internal)')) return false;
  if ((q as any).multiple === true) return false;
  const rawOptions = Array.isArray(q.options) ? q.options : [];
  const options = rawOptions.map((opt) => (asRecord(opt) ?? null)).filter(Boolean) as Array<Record<string, unknown>>;
  if (options.length !== 1) return false;
  const label = normalizeString(options[0]!.label).trim().toLowerCase();
  if (label !== 'ok') return false;
  return true;
}

export function buildQuestionAnswersArray(params: {
  questions: ReadonlyArray<Record<string, unknown>>;
  answersByQuestionKey: Record<string, string>;
}): string[][] {
  const out: string[][] = [];
  for (const q of params.questions) {
    const question = normalizeString(q.question);
    const header = normalizeString(q.header);
    const key = question.trim().length > 0 ? question : header;
    const raw = typeof params.answersByQuestionKey[key] === 'string' ? params.answersByQuestionKey[key]! : '';
    if (!raw) {
      out.push([]);
      continue;
    }
    out.push(openCodeQuestionRecordLooksFreeform(q) ? [raw] : splitCommaSeparatedLabels(raw));
  }
  return out;
}

export function parseQuestionRequest(raw: unknown): OpenCodeQuestionRequest | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = normalizeString(rec.id);
  const sessionID = normalizeString(rec.sessionID);
  if (!id || !sessionID) return null;
  const questionsRaw = rec.questions;
  const questions = Array.isArray(questionsRaw) ? questionsRaw : [];
  const toolRec = asRecord(rec.tool);
  const tool = toolRec
    ? { messageID: normalizeString(toolRec.messageID), callID: normalizeString(toolRec.callID) }
    : undefined;
  return { id, sessionID, questions, ...(tool?.messageID && tool.callID ? { tool } : {}) };
}
