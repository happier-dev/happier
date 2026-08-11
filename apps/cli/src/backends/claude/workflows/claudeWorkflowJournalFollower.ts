import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildWorkflowAgentSidechainId } from '@happier-dev/protocol';

import {
  createJsonlFollowController,
  type JsonlFollowController,
  type JsonlFollowControllerWatchFile,
} from '@/agent/localControl/jsonlFollowController';
import type { JsonlFollowPolicyInput } from '@/agent/localControl/jsonlFollowPolicy';
import { logger } from '@/ui/logger';

import {
  createClaudeWorkflowAgentProfileWrapper,
  createClaudeWorkflowJournalWrapper,
  createClaudeWorkflowScriptWrapper,
  parseClaudeWorkflowFact,
} from './claudeWorkflowCorrelation';

/**
 * The one reader of a workflow run's on-disk SIDECAR directory.
 *
 * Three artifacts live beside each other under the run's `transcriptDir`, and the journal is the
 * only one anything used to read:
 * - `journal.jsonl` — lifecycle, but `{type, key, agentId}` only, so every running agent is a hex id;
 * - `agent-<agentId>.jsonl` — that agent's own first prompt, the only place it says who it is;
 * - `agent-<agentId>.meta.json` — that agent's model.
 *
 * The workflow SCRIPT is read here too: the `Workflow` tool has two input shapes and a
 * `{scriptPath}` launch inlines nothing, so its phases and agent labels exist only in that file.
 */

/** A prompt head is a title source, not a payload: read a bounded prefix, never the whole transcript. */
const AGENT_TRANSCRIPT_HEAD_MAX_BYTES = 512 * 1024;

/**
 * What the sidecar directory has said about one agent so far, and which of those answers are FINAL.
 *
 * The distinction is the whole point of this record. The directory is written by someone else, in
 * an order this follower does not control: `agent-<id>.meta.json` can be readable before
 * `agent-<id>.jsonl` exists, so the first read of a perfectly healthy agent can prove a model and
 * nothing else. A latch that means "we tried once" turns that ordinary race into a permanent
 * verdict — the agent keeps its model, never gets its sidechain, and its row is unopenable for the
 * life of the run, because runs terminalize on restart and the follower does not replay.
 *
 * So a fact is latched only when re-reading could not change it. `settled` is not `known`: a model
 * that is genuinely absent from a readable `meta.json` is settled and undefined, while a
 * `meta.json` that is not there yet is neither.
 */
type WorkflowAgentProfileFacts = {
  prompt: string | undefined;
  model: string | undefined;
  sidechainId: string | undefined;
  /** The transcript's first record parsed, so the prompt it declares (or declines to) is final. */
  promptSettled: boolean;
  /** `meta.json` was readable and parsed, so its model (or its absence) is final. */
  modelSettled: boolean;
  /** The importer accepted the file — or there is no importer, so nothing ever will. */
  sidechainSettled: boolean;
  /** A read is in flight; a second journal entry must not race a duplicate one against it. */
  reading: boolean;
};

type WorkflowJournalEntry = Readonly<{
  workflowToolUseId: string;
  transcriptDir: string;
  sourceSessionId?: string;
  controller: JsonlFollowController;
  /** Per-agent sidecar facts, so the run re-reads exactly what it has not yet settled. */
  agentProfiles: Map<string, WorkflowAgentProfileFacts>;
}>;

export type ClaudeWorkflowJournalFollower = Readonly<{
  observeTranscriptMessage(message: unknown): void;
  markRunCompleted(runId: string): void;
  syncAll(): Promise<void>;
  dispose(): void;
}>;

/**
 * One workflow agent's sidecar transcript, handed to the sidechain importer.
 *
 * The follower does not import it: `ClaudeRemoteSubagentFileCollector` is the one importer for every
 * Claude sub-agent transcript, and it already owns following, per-sidechain dedupe, follower caps
 * and the `isSidechain`/`sidechainId` marking. This registration is the handover, and it happens
 * here because this is the only component that holds the run's directory.
 */
export type ClaudeWorkflowAgentTranscriptRegistration = Readonly<{
  workflowToolUseId: string;
  agentId: string;
  /** Minted by the protocol owner. Never composed here, and never by the UI. */
  sidechainId: string;
  filePath: string;
}>;

function readJournalEntryAgentId(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const agentId = (entry as Record<string, unknown>).agentId;
  return typeof agentId === 'string' && agentId.trim().length > 0 ? agentId.trim() : null;
}

/**
 * The head of an agent's sidecar transcript, and whether the file was there at all.
 *
 * Existence is reported separately from content because two different decisions read this: the
 * title only needs the first record, while the import needs proof the file EXISTS. A file that
 * opens but whose first record is unparseable still has a transcript worth importing.
 */
type AgentTranscriptHead =
  | Readonly<{ exists: true; record: Record<string, unknown> | null }>
  | Readonly<{ exists: false }>;

async function readAgentTranscriptHead(filePath: string): Promise<AgentTranscriptHead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, 'r');
  } catch {
    return { exists: false };
  }
  try {
    return { exists: true, record: await readFirstJsonlRecord(handle) };
  } catch {
    return { exists: true, record: null };
  } finally {
    await handle.close();
  }
}

/** The first JSONL line of an agent transcript, read from a bounded prefix of the file. */
async function readFirstJsonlRecord(handle: Awaited<ReturnType<typeof open>>): Promise<Record<string, unknown> | null> {
  {
    const buffer = Buffer.allocUnsafe(AGENT_TRANSCRIPT_HEAD_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, AGENT_TRANSCRIPT_HEAD_MAX_BYTES, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8');
    const newlineIndex = head.indexOf('\n');
    // No newline inside the prefix means the first record is larger than the bound; a truncated
    // record cannot be parsed, and guessing at its contents would invent a name.
    if (newlineIndex < 0 && bytesRead === AGENT_TRANSCRIPT_HEAD_MAX_BYTES) return null;
    const line = (newlineIndex >= 0 ? head.slice(0, newlineIndex) : head).trim();
    if (line.length === 0) return null;
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  }
}

function readAgentPromptText(record: Record<string, unknown> | null): string | undefined {
  const message = record?.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record_ = item as Record<string, unknown>;
    if (record_.type === 'text' && typeof record_.text === 'string') parts.push(record_.text);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * The agent's model, and whether the file answered at all.
 *
 * Same separation as the transcript head, for the same reason: "this `meta.json` names no model"
 * is an answer, while "this `meta.json` is not on disk yet" is not one, and collapsing both to
 * `undefined` is how a not-yet becomes a never.
 */
type AgentModelRead =
  | Readonly<{ settled: true; model: string | undefined }>
  | Readonly<{ settled: false }>;

/** Whether the importer gave a final answer, and the id it filed the transcript under if it did. */
type SidecarImportResult =
  | Readonly<{ settled: true; sidechainId: string | undefined }>
  | Readonly<{ settled: false }>;

async function readAgentModel(metaPath: string): Promise<AgentModelRead> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(metaPath, 'utf8'));
  } catch {
    return { settled: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { settled: true, model: undefined };
  }
  const model = (parsed as Record<string, unknown>).model;
  return {
    settled: true,
    model: typeof model === 'string' && model.trim().length > 0 ? model.trim() : undefined,
  };
}

export function createClaudeWorkflowJournalFollower(params: Readonly<{
  onJournalValue: (value: unknown) => void;
  /**
   * Hand a workflow agent's sidecar transcript to the sidechain importer.
   *
   * Absent when no importer is wired (a scanner-only or test composition); the run then keeps its
   * naming and loses only the transcripts, and no agent claims a sidechain it does not have.
   */
  registerAgentTranscript?: ((
    registration: ClaudeWorkflowAgentTranscriptRegistration,
  ) => void | Promise<void>) | undefined;
  watchFile?: JsonlFollowControllerWatchFile | undefined;
  followPolicy?: JsonlFollowPolicyInput | undefined;
  logPrefix?: string | undefined;
}>): ClaudeWorkflowJournalFollower {
  const logPrefix = params.logPrefix ?? '[claude-workflow-journal]';
  const entriesByRunId = new Map<string, WorkflowJournalEntry>();
  const pendingRegistrations = new Set<Promise<void>>();
  const pendingSidecarReads = new Set<Promise<void>>();
  const scriptsReadByRunId = new Set<string>();

  function trackSidecarRead(read: Promise<void>): void {
    pendingSidecarReads.add(read);
    void read.finally(() => pendingSidecarReads.delete(read));
  }

  /**
   * Hand one agent's sidecar transcript to the sidechain importer, and report the id it was filed
   * under — or nothing, when nothing was imported.
   *
   * Proof, not intent. The id is returned only after the importer accepted a file we opened, so a
   * row built from it is pressable exactly when there is something to open. An id minted from the
   * ids alone would be equally well-formed and would make an agent with no sidecar press into
   * nothing.
   *
   * A REJECTED registration is unsettled, not empty: the importer may simply not be wired yet, and
   * a later journal entry gets to try again. A composition with no importer at all is settled —
   * a scanner keeps its naming and loses only the transcripts, and no retry can change that.
   */
  async function importAgentTranscript(
    entry: WorkflowJournalEntry,
    agentId: string,
    filePath: string,
  ): Promise<SidecarImportResult> {
    const register = params.registerAgentTranscript;
    if (!register) return { settled: true, sidechainId: undefined };
    const sidechainId = buildWorkflowAgentSidechainId({
      workflowToolUseId: entry.workflowToolUseId,
      agentId,
    });
    try {
      await register({ workflowToolUseId: entry.workflowToolUseId, agentId, sidechainId, filePath });
    } catch (error) {
      logger.debug(`${logPrefix}: could not import the sidecar transcript for ${agentId}`, error);
      return { settled: false };
    }
    return { settled: true, sidechainId };
  }

  /**
   * Read whatever this agent's sidecar directory can still tell us, and republish when it told us
   * something new.
   *
   * Called on every journal entry that names the agent, and cheap after the first one: each fact
   * stops being re-read the moment re-reading it could not change the answer. The profile is
   * re-emitted with the ACCUMULATED facts rather than the delta, because the tracker merges them
   * and a partial second wrapper would read as a correction.
   */
  function emitAgentProfile(entry: WorkflowJournalEntry, agentId: string): void {
    let facts = entry.agentProfiles.get(agentId);
    if (!facts) {
      facts = {
        prompt: undefined,
        model: undefined,
        sidechainId: undefined,
        promptSettled: false,
        modelSettled: false,
        sidechainSettled: false,
        reading: false,
      };
      entry.agentProfiles.set(agentId, facts);
    }
    const state = facts;
    if (state.reading) return;
    if (state.promptSettled && state.modelSettled && state.sidechainSettled) return;
    state.reading = true;
    trackSidecarRead((async () => {
      try {
        const base = join(entry.transcriptDir, `agent-${agentId}`);
        let learned = false;

        if (!state.promptSettled || !state.sidechainSettled) {
          // One bounded head read serves BOTH answers this directory can give about an anonymous
          // agent: the name its prompt declares, and whether it has a transcript to import at all.
          const head = await readAgentTranscriptHead(`${base}.jsonl`);
          if (!head.exists) {
            logger.debug(`${logPrefix}: no readable agent transcript for ${agentId} yet`);
          } else {
            if (!state.promptSettled && head.record !== null) {
              state.prompt = readAgentPromptText(head.record);
              state.promptSettled = true;
              if (state.prompt !== undefined) learned = true;
            }
            if (!state.sidechainSettled) {
              const imported = await importAgentTranscript(entry, agentId, `${base}.jsonl`);
              if (imported.settled) {
                state.sidechainId = imported.sidechainId;
                state.sidechainSettled = true;
                if (state.sidechainId !== undefined) learned = true;
              }
            }
          }
        }

        if (!state.modelSettled) {
          const read = await readAgentModel(`${base}.meta.json`);
          if (read.settled) {
            state.model = read.model;
            state.modelSettled = true;
            if (state.model !== undefined) learned = true;
          }
        }

        // Nothing new was proven about this agent, so there is nothing to say about it yet. The
        // unsettled facts above are what bring a later journal entry back here.
        if (!learned) return;
        params.onJournalValue(createClaudeWorkflowAgentProfileWrapper({
          workflowToolUseId: entry.workflowToolUseId,
          agentId,
          ...(state.prompt !== undefined ? { prompt: state.prompt } : {}),
          ...(state.model !== undefined ? { model: state.model } : {}),
          ...(state.sidechainId !== undefined ? { sidechainId: state.sidechainId } : {}),
          ...(entry.sourceSessionId ? { sourceSessionId: entry.sourceSessionId } : {}),
        }));
      } finally {
        state.reading = false;
      }
    })());
  }

  function readWorkflowScript(paramsForScript: Readonly<{
    workflowToolUseId: string;
    scriptPath: string;
    sourceSessionId?: string | undefined;
  }>): void {
    if (scriptsReadByRunId.has(paramsForScript.workflowToolUseId)) return;
    scriptsReadByRunId.add(paramsForScript.workflowToolUseId);
    trackSidecarRead((async () => {
      let script: string;
      try {
        script = await readFile(paramsForScript.scriptPath, 'utf8');
      } catch (error) {
        logger.debug(`${logPrefix}: could not read workflow script ${paramsForScript.scriptPath}`, error);
        scriptsReadByRunId.delete(paramsForScript.workflowToolUseId);
        return;
      }
      if (script.trim().length === 0) return;
      params.onJournalValue(createClaudeWorkflowScriptWrapper({
        workflowToolUseId: paramsForScript.workflowToolUseId,
        script,
        ...(paramsForScript.sourceSessionId ? { sourceSessionId: paramsForScript.sourceSessionId } : {}),
      }));
    })());
  }

  function registerJournal(paramsForRun: Readonly<{
    workflowToolUseId: string;
    transcriptDir: string;
    sourceSessionId?: string | undefined;
  }>): void {
    const existing = entriesByRunId.get(paramsForRun.workflowToolUseId);
    if (existing?.transcriptDir === paramsForRun.transcriptDir) return;
    if (existing) {
      void existing.controller.stop();
      entriesByRunId.delete(paramsForRun.workflowToolUseId);
    }

    const journalPath = join(paramsForRun.transcriptDir, 'journal.jsonl');
    const controller = createJsonlFollowController({
      filePath: journalPath,
      ...(params.followPolicy ? { pollPolicy: params.followPolicy } : {}),
      ...(params.watchFile ? { watchFile: params.watchFile } : {}),
      onJson: (entry) => {
        params.onJournalValue(createClaudeWorkflowJournalWrapper({
          workflowToolUseId: paramsForRun.workflowToolUseId,
          entry,
          ...(paramsForRun.sourceSessionId ? { sourceSessionId: paramsForRun.sourceSessionId } : {}),
        }));
        const registered = entriesByRunId.get(paramsForRun.workflowToolUseId);
        const agentId = readJournalEntryAgentId(entry);
        if (registered && agentId) emitAgentProfile(registered, agentId);
      },
      onError: (error) => {
        logger.debug(`${logPrefix}: workflow journal follower error for ${paramsForRun.workflowToolUseId}`, error);
      },
      onClosed: () => {
        const current = entriesByRunId.get(paramsForRun.workflowToolUseId);
        if (current?.controller === controller) entriesByRunId.delete(paramsForRun.workflowToolUseId);
      },
    });

    entriesByRunId.set(paramsForRun.workflowToolUseId, {
      workflowToolUseId: paramsForRun.workflowToolUseId,
      transcriptDir: paramsForRun.transcriptDir,
      ...(paramsForRun.sourceSessionId ? { sourceSessionId: paramsForRun.sourceSessionId } : {}),
      controller,
      agentProfiles: new Map<string, WorkflowAgentProfileFacts>(),
    });

    const registration = controller.start().catch((error) => {
      logger.debug(`${logPrefix}: workflow journal follower failed to start for ${paramsForRun.workflowToolUseId}`, error);
    });
    pendingRegistrations.add(registration);
    void registration.finally(() => pendingRegistrations.delete(registration));
  }

  return {
    observeTranscriptMessage(message) {
      const fact = parseClaudeWorkflowFact(message);
      if (fact?.kind !== 'workflow-launch') return;
      if (fact.scriptPath) {
        readWorkflowScript({
          workflowToolUseId: fact.workflowToolUseId,
          scriptPath: fact.scriptPath,
          ...(fact.sourceSessionId ? { sourceSessionId: fact.sourceSessionId } : {}),
        });
      }
      if (!fact.transcriptDir) return;
      registerJournal({
        workflowToolUseId: fact.workflowToolUseId,
        transcriptDir: fact.transcriptDir,
        ...(fact.sourceSessionId ? { sourceSessionId: fact.sourceSessionId } : {}),
      });
    },
    markRunCompleted(runId) {
      entriesByRunId.get(runId)?.controller.markCompleted();
    },
    async syncAll() {
      if (pendingRegistrations.size > 0) {
        await Promise.allSettled([...pendingRegistrations]);
      }
      for (const entry of entriesByRunId.values()) {
        await entry.controller.drainNow();
      }
      // Sidecar reads are started BY the drain above, so they are awaited after it.
      while (pendingSidecarReads.size > 0) {
        await Promise.allSettled([...pendingSidecarReads]);
      }
    },
    dispose() {
      for (const entry of entriesByRunId.values()) {
        void entry.controller.stop();
      }
      entriesByRunId.clear();
      pendingRegistrations.clear();
      pendingSidecarReads.clear();
      scriptsReadByRunId.clear();
    },
  };
}
