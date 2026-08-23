import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createTestAuth, type TestAuth } from './auth';
import { upsertEncryptedAccountSettingsV2 } from './accountSettings';
import { seedCliAuthForServer } from './cliAuth';
import { writeCliSessionAttachFile } from './cliAttachFile';
import { stopDaemonFromHomeDir } from './daemon/daemon';
import { writeTestManifestForServer } from './manifestForServer';
import { encryptLegacyBase64 } from './messageCrypto';
import { repoRootDir } from './paths';
import { startServerLight, type StartedServer } from './process/serverLight';
import { spawnLoggedProcess, type SpawnedProcess } from './process/spawnProcess';
import { yarnCommand } from './process/commands';
import { createSessionWithCiphertexts, fetchSessionV2, type SessionV2 } from './sessions';

export type FakeCodexAppServerRequest = Readonly<{
  method?: string;
  params?: Record<string, unknown> | null;
}>;

export type FakeCodexAppServerGoal = Readonly<{
  threadId: string;
  objective: string;
  status: 'active' | 'paused' | 'budgetLimited' | 'complete';
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
}>;

export type FakeCodexAppServerVendorPlugin = Readonly<{
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  mentionPath: string;
  installed: boolean;
  enabled: boolean;
}>;

export type FakeCodexAppServerSkill = Readonly<{
  name: string;
  displayName?: string;
  description?: string;
  path: string;
  enabled: boolean;
}>;

function createDefaultFakeCodexVendorPlugins(): FakeCodexAppServerVendorPlugin[] {
  return [
    {
      id: 'reviewer@codex',
      name: 'reviewer',
      displayName: 'Reviewer',
      description: 'Review session context from the fake Codex app-server.',
      mentionPath: 'plugin://reviewer@codex',
      installed: true,
      enabled: true,
    },
  ];
}

function createDefaultFakeCodexSkills(dir: string): FakeCodexAppServerSkill[] {
  return [
    {
      name: 'code-review',
      displayName: 'Code Review',
      description: 'Review code with the fake Codex app-server.',
      path: join(dir, 'skills', 'code-review', 'SKILL.md'),
      enabled: true,
    },
  ];
}

export async function writeFakeCodexAppServerScript(params: Readonly<{
  dir: string;
  requestLogPath: string;
  /**
   * Test-only strict resume boundary. When set, the fake app-server must reject
   * a `thread/resume` request that names any other native thread.
   */
  expectedResumeThreadId?: string;
  initialGoal?: FakeCodexAppServerGoal | null;
  goalSetBehavior?: 'objectiveRequired' | 'nativePartial';
  vendorPlugins?: readonly FakeCodexAppServerVendorPlugin[];
  skills?: readonly FakeCodexAppServerSkill[];
}>): Promise<string> {
  const scriptPath = join(params.dir, 'fake-codex-app-server.mjs');
  const expectedResumeThreadId = typeof params.expectedResumeThreadId === 'string'
    && params.expectedResumeThreadId.trim().length > 0
    ? params.expectedResumeThreadId.trim()
    : null;
  const initialGoal = params.initialGoal ?? null;
  const goalSetBehavior = params.goalSetBehavior ?? 'objectiveRequired';
  const vendorPlugins = params.vendorPlugins ?? createDefaultFakeCodexVendorPlugins();
  const skills = params.skills ?? createDefaultFakeCodexSkills(params.dir);
  const script = [
    '#!/usr/bin/env node',
    'import { appendFile, readFile, rm, writeFile } from "node:fs/promises";',
    'import readline from "node:readline";',
    `const requestLogPath = ${JSON.stringify(params.requestLogPath)};`,
    `const expectedResumeThreadId = ${JSON.stringify(expectedResumeThreadId)};`,
    `const goalStatePath = ${JSON.stringify(join(params.dir, 'fake-codex-app-server.goal.json'))};`,
    `const accountStatePath = ${JSON.stringify(join(params.dir, 'fake-codex-app-server.account.json'))};`,
    `let currentGoal = ${JSON.stringify(initialGoal)};`,
    `const goalSetBehavior = ${JSON.stringify(goalSetBehavior)};`,
    `const vendorPlugins = ${JSON.stringify(vendorPlugins)};`,
    `const skills = ${JSON.stringify(skills)};`,
    'function readNonEmptyString(value) {',
    '  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;',
    '}',
    'function parseJsonObject(value) {',
    '  if (!value) return {};',
    '  try {',
    '    const parsed = JSON.parse(String(value));',
    '    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};',
    '  } catch {',
    '    return {};',
    '  }',
    '}',
    'const accountEmailOverrides = parseJsonObject(process.env.HAPPIER_E2E_FAKE_CODEX_APP_SERVER_ACCOUNT_EMAILS_JSON);',
    'const exhaustedAccountIds = new Set(String(process.env.HAPPIER_E2E_FAKE_CODEX_APP_SERVER_EXHAUSTED_ACCOUNT_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean));',
    'const loginFailureAccountIds = new Set(String(process.env.HAPPIER_E2E_FAKE_CODEX_APP_SERVER_LOGIN_FAIL_ACCOUNT_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean));',
    'let currentAccountId = readNonEmptyString(process.env.HAPPIER_E2E_FAKE_CODEX_APP_SERVER_INITIAL_ACCOUNT_ID) ?? "acct-1";',
    'function readAuthStoreAccountIdFromRecord(record) {',
    '  if (!record || typeof record !== "object" || Array.isArray(record)) return null;',
    '  const tokens = record.tokens && typeof record.tokens === "object" && !Array.isArray(record.tokens) ? record.tokens : null;',
    '  return readNonEmptyString(record.chatgptAccountId)',
    '    ?? readNonEmptyString(record.chatgpt_account_id)',
    '    ?? readNonEmptyString(record.account_id)',
    '    ?? readNonEmptyString(record.accountId)',
    '    ?? readNonEmptyString(tokens?.chatgptAccountId)',
    '    ?? readNonEmptyString(tokens?.chatgpt_account_id)',
    '    ?? readNonEmptyString(tokens?.account_id)',
    '    ?? readNonEmptyString(tokens?.accountId);',
    '}',
    'async function readInitialAccountIdFromDisk() {',
    '  try {',
    '    const persistedRaw = await readFile(accountStatePath, "utf8");',
    '    const persisted = JSON.parse(persistedRaw);',
    '    const persistedId = readAuthStoreAccountIdFromRecord(persisted) ?? readNonEmptyString(persisted?.accountId);',
    '    if (persistedId) return persistedId;',
    '  } catch {}',
    '  const codexHome = readNonEmptyString(process.env.CODEX_HOME);',
    '  if (!codexHome) return null;',
    '  try {',
    '    const authStoreRaw = await readFile(`${codexHome}/auth.json`, "utf8");',
    '    return readAuthStoreAccountIdFromRecord(JSON.parse(authStoreRaw));',
    '  } catch {',
    '    return null;',
    '  }',
    '}',
    'const initialAccountIdFromDisk = await readInitialAccountIdFromDisk();',
    'if (initialAccountIdFromDisk) currentAccountId = initialAccountIdFromDisk;',
    'async function persistAccountState() {',
    '  await writeFile(accountStatePath, JSON.stringify({ accountId: currentAccountId }), "utf8");',
    '}',
    'function emailForAccountId(accountId) {',
    '  return readNonEmptyString(accountEmailOverrides[accountId]) ?? `${accountId}@example.test`;',
    '}',
    'function buildAccountReadResponse() {',
    '  return { account: { email: emailForAccountId(currentAccountId), planType: "pro" } };',
    '}',
    'function buildRateLimitsReadResponse() {',
    '  const exhausted = exhaustedAccountIds.has(currentAccountId);',
    '  return {',
    '    plan_type: "pro",',
    '    primary: {',
    '      used_percent: exhausted ? 100 : 3,',
    '      resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),',
    '    },',
    '  };',
    '}',
    'function redactRequestParams(method, params) {',
    '  if (!params || typeof params !== "object" || Array.isArray(params)) return params ?? null;',
    '  if (method !== "account/login/start") return params;',
    '  const redacted = { ...params };',
    '  if (Object.prototype.hasOwnProperty.call(redacted, "accessToken")) redacted.accessToken = "[redacted]";',
    '  if (Object.prototype.hasOwnProperty.call(redacted, "refreshToken")) redacted.refreshToken = "[redacted]";',
    '  if (Object.prototype.hasOwnProperty.call(redacted, "chatgptAuthTokens")) redacted.chatgptAuthTokens = "[redacted]";',
    '  return redacted;',
    '}',
    'function appendRequestLogEntry(entry) {',
    '  return appendFile(requestLogPath, JSON.stringify(entry) + "\\n");',
    '}',
    'function appendHarnessEvent(method, params) {',
    '  return appendRequestLogEntry({ method, params }).catch(() => {});',
    '}',
    'try {',
    '  const persistedGoalRaw = await readFile(goalStatePath, "utf8");',
    '  const persistedGoal = JSON.parse(persistedGoalRaw);',
    '  currentGoal = persistedGoal && typeof persistedGoal === "object" ? persistedGoal : currentGoal;',
    '} catch {}',
    'async function persistGoal() {',
    '  if (!currentGoal) {',
    '    await rm(goalStatePath, { force: true });',
    '    return;',
    '  }',
    '  await writeFile(goalStatePath, JSON.stringify(currentGoal), "utf8");',
    '}',
    'const turnDelayMsRaw = process.env.HAPPIER_E2E_FAKE_CODEX_APP_SERVER_TURN_DELAY_MS;',
    'const turnDelayMs = (() => {',
    '  if (!turnDelayMsRaw) return 0;',
    '  const parsed = Number.parseInt(String(turnDelayMsRaw), 10);',
    '  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;',
    '})();',
    'const nativeGoalSuccessorEnabled = process.env.HAPPIER_E2E_FAKE_CODEX_APP_SERVER_NATIVE_GOAL_SUCCESSOR === "1";',
    'const nativeGoalSuccessorDelayMs = (() => {',
    '  const parsed = Number.parseInt(String(process.env.HAPPIER_E2E_FAKE_CODEX_APP_SERVER_NATIVE_GOAL_SUCCESSOR_DELAY_MS ?? ""), 10);',
    '  return Number.isFinite(parsed) && parsed > 0 ? parsed : Math.max(250, turnDelayMs * 2);',
    '})();',
    'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
    'let turnCounter = 0;',
    'let activeTurnId = null;',
    'let activeTurn = null;',
    'let completedTurns = [];',
    'let nativeGoalSuccessorLaunched = false;',
    'let nativeGoalActivationAt = 0;',
    'function readReviewLabel(target) {',
    '  if (target?.custom && typeof target.custom.instructions === "string") return target.custom.instructions.trim() || "custom review";',
    '  if (target?.type === "custom" && typeof target.instructions === "string") return target.instructions.trim() || "custom review";',
    '  if (typeof target?.instructions === "string") return target.instructions.trim() || "custom review";',
    '  if (target?.baseBranch && typeof target.baseBranch.branch === "string") return `changes against ${target.baseBranch.branch}`;',
    '  if (target?.type === "baseBranch" && typeof target.branch === "string") return `changes against ${target.branch}`;',
    '  if (target?.commit && typeof target.commit.sha === "string") return `commit ${target.commit.sha}`;',
    '  if (target?.type === "commit" && typeof target.sha === "string") return `commit ${target.sha}`;',
    '  if (target === "uncommittedChanges" || target?.uncommittedChanges != null || target?.type === "uncommittedChanges") return "current changes";',
    '  return "custom review";',
    '}',
    'function buildFakeReviewText() {',
    '  const overviewMarkdown = [',
    '    "Native Codex review completed.",',
    '    "",',
    '    "Full review comments:",',
    '    "",',
    '    "- Duplicate assistant text is persisted once - /fake/workspace/src/nativeReview.ts:12-14",',
    '    "  The review bridge should not store both exitedReviewMode text and the matching final assistant message as duplicate output.",',
    '  ].join("\\n");',
    '  return JSON.stringify({',
    '    summary: "Native Codex review completed.",',
    '    overviewMarkdown,',
    '    findings: [{',
    '      id: "fake-native-review-finding",',
    '      title: "Duplicate assistant text is persisted once",',
    '      severity: "medium",',
    '      category: "correctness",',
    '      summary: "The review bridge should not store both exitedReviewMode text and the matching final assistant message as duplicate output.",',
    '      filePath: "/fake/workspace/src/nativeReview.ts",',
    '      startLine: 12,',
    '      endLine: 14,',
    '    }],',
    '    questions: [],',
    '    assumptions: [],',
    '  });',
    '}',
    'function marketplaceNameForPlugin(plugin) {',
    '  const mentionPath = typeof plugin?.mentionPath === "string" ? plugin.mentionPath : "";',
    '  const match = /^plugin:\\/\\/[^@]+@(.+)$/.exec(mentionPath);',
    '  return match?.[1] ?? "codex";',
    '}',
    'function buildPluginListResponse() {',
    '  const byMarketplace = new Map();',
    '  for (const plugin of vendorPlugins) {',
    '    const marketplaceName = marketplaceNameForPlugin(plugin);',
    '    const entry = byMarketplace.get(marketplaceName) ?? { name: marketplaceName, path: null, interface: null, plugins: [] };',
    '    entry.plugins.push({ id: plugin.id, remotePluginId: null, localVersion: null, name: plugin.name, shareContext: null, source: { type: "remote" }, installed: plugin.installed === true, enabled: plugin.enabled === true, installPolicy: "INSTALLED_BY_DEFAULT", authPolicy: "ON_USE", availability: "AVAILABLE", interface: { displayName: plugin.displayName ?? plugin.name, shortDescription: plugin.description ?? null, longDescription: plugin.description ?? null, developerName: null, category: null, capabilities: [], websiteUrl: null, privacyPolicyUrl: null, termsOfServiceUrl: null, defaultPrompt: null, brandColor: null, composerIcon: null, composerIconUrl: null, logo: null, logoUrl: null, screenshots: [], screenshotUrls: [] }, keywords: [] });',
    '    byMarketplace.set(marketplaceName, entry);',
    '  }',
    '  return { marketplaces: [...byMarketplace.values()], marketplaceLoadErrors: [], featuredPluginIds: [] };',
    '}',
    'function buildSkillsListResponse(cwd) {',
    '  return { data: [{ cwd, skills: skills.map((skill) => ({ name: skill.name, description: skill.description ?? "", shortDescription: skill.description ?? null, interface: { displayName: skill.displayName ?? skill.name, shortDescription: skill.description ?? null, iconSmall: null, iconLarge: null, brandColor: null, defaultPrompt: null }, dependencies: null, path: skill.path, scope: "repo", enabled: skill.enabled === true })), errors: [] }] };',
    '}',
    'for await (const line of rl) {',
    '  if (!line.trim()) continue;',
    '  const msg = JSON.parse(line);',
    '  await appendRequestLogEntry({ method: msg.method ?? null, params: redactRequestParams(msg.method, msg.params ?? null) });',
    '  if (msg.method === "initialize") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake-codex-app-server", version: "0.0.0" } } }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "initialized") continue;',
    '  if (msg.method === "thread/start") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: "thread-started", model: "gpt-5.4", serviceTier: null } }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "thread/resume") {',
    '    const requestedThreadId = typeof msg.params?.threadId === "string" ? msg.params.threadId : null;',
    '    if (expectedResumeThreadId !== null && requestedThreadId !== expectedResumeThreadId) {',
    '      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "thread/resume rejected unexpected thread id" } }) + "\\n");',
    '      continue;',
    '    }',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: msg.params?.threadId ?? null, model: "gpt-5.4", serviceTier: null } }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "thread/read") {',
    '    const threadId = typeof msg.params?.threadId === "string" ? msg.params.threadId : "thread-started";',
    '    const turns = completedTurns.filter((turn) => turn.threadId === threadId);',
    '    if (activeTurn?.threadId === threadId) turns.push(activeTurn);',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId, turns: msg.params?.includeTurns === true ? turns : [] } }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "collaborationMode/list") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: [{ name: "Default", mode: "default", reasoning_effort: null }] }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "model/list") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: [{ id: "gpt-5.4", displayName: "GPT-5.4", isDefault: true }] }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "account/read") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: buildAccountReadResponse() }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "account/rateLimits/read") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: buildRateLimitsReadResponse() }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "account/login/start") {',
    '    const accountId = readNonEmptyString(msg.params?.chatgptAccountId)',
    '      ?? readNonEmptyString(msg.params?.chatgpt_account_id)',
    '      ?? readNonEmptyString(msg.params?.accountId)',
    '      ?? readNonEmptyString(msg.params?.account_id);',
    '    if (!accountId) {',
    '      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "chatgptAccountId required" } }) + "\\n");',
    '      continue;',
    '    }',
    '    if (loginFailureAccountIds.has(accountId)) {',
    '      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "fake login failure" } }) + "\\n");',
    '      continue;',
    '    }',
    '    currentAccountId = accountId;',
    '    await persistAccountState();',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "thread/goal/get") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: currentGoal }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "thread/goal/set") {',
    '    const nowIso = new Date().toISOString();',
    '    const providedObjective = typeof msg.params?.objective === "string" ? msg.params.objective.trim() : "";',
    '    const objective = providedObjective || (goalSetBehavior === "nativePartial" && currentGoal?.objective ? currentGoal.objective : "");',
    '    if (!objective) {',
    '      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "objective required" } }) + "\\n");',
    '      continue;',
    '    }',
    '    const tokenBudget = Object.prototype.hasOwnProperty.call(msg.params ?? {}, "tokenBudget")',
    '      ? msg.params.tokenBudget',
    '      : (goalSetBehavior === "nativePartial" && currentGoal && Object.prototype.hasOwnProperty.call(currentGoal, "tokenBudget") ? currentGoal.tokenBudget : null);',
    '    currentGoal = {',
    '      threadId: typeof msg.params?.threadId === "string" ? msg.params.threadId : "thread-started",',
    '      objective,',
    '      status: typeof msg.params?.status === "string" ? msg.params.status : (goalSetBehavior === "nativePartial" && currentGoal?.status ? currentGoal.status : "active"),',
    '      tokenBudget,',
    '      tokensUsed: goalSetBehavior === "nativePartial" && typeof currentGoal?.tokensUsed === "number" ? currentGoal.tokensUsed : 0,',
    '      timeUsedSeconds: goalSetBehavior === "nativePartial" && typeof currentGoal?.timeUsedSeconds === "number" ? currentGoal.timeUsedSeconds : 0,',
    '      createdAt: goalSetBehavior === "nativePartial" && typeof currentGoal?.createdAt === "string" ? currentGoal.createdAt : nowIso,',
    '      updatedAt: nowIso',
    '    };',
    '    if (nativeGoalSuccessorEnabled && activeTurn && currentGoal.status === "active") nativeGoalActivationAt = Date.now();',
    '    await persistGoal();',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: currentGoal }) + "\\n");',
    '    process.stdout.write(JSON.stringify({ method: "thread/goal/updated", params: { threadId: currentGoal.threadId, goal: currentGoal } }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "thread/goal/clear") {',
    '    const threadId = typeof msg.params?.threadId === "string" ? msg.params.threadId : currentGoal?.threadId ?? "thread-started";',
    '    currentGoal = null;',
    '    await persistGoal();',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId } }) + "\\n");',
    '    process.stdout.write(JSON.stringify({ method: "thread/goal/cleared", params: { threadId } }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "plugin/list") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: buildPluginListResponse() }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "plugin/read") {',
    '    const pluginId = typeof msg.params?.id === "string" ? msg.params.id : null;',
    '    const path = typeof msg.params?.path === "string" ? msg.params.path : null;',
    '    const plugin = vendorPlugins.find((candidate) => candidate.id === pluginId || candidate.mentionPath === path) ?? null;',
    '    if (!plugin) {',
    '      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "plugin not found" } }) + "\\n");',
    '      continue;',
    '    }',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: plugin }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "skills/list") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: buildSkillsListResponse(msg.params?.cwds?.[0] ?? null) }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "turn/start") {',
    '    turnCounter += 1;',
    '    const threadId = msg.params?.threadId ?? "thread-started";',
    '    const input = Array.isArray(msg.params?.input) ? msg.params.input : [];',
    '    const promptText = String(input[0]?.text ?? `prompt-${turnCounter}`);',
    '    const turnId = `turn-${turnCounter}`;',
    '    activeTurnId = turnId;',
    '    activeTurn = { id: turnId, threadId, items: [{ type: "userMessage", text: promptText }] };',
    '    const messageId = `msg_${turnCounter}`;',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, threadId } }) + "\\n");',
    '    if (promptText === "usage-limit-structured") {',
    '      const usageLimitError = { message: "Usage limit reached", codexErrorInfo: "UsageLimitExceeded", resetsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), planType: "pro", rateLimits: { primary: { usedPercent: 100 } }, additionalDetails: null };',
    '      setTimeout(async () => {',
    '        await appendHarnessEvent("happier/test/turn/completed", { threadId, turnId, promptText, status: "failed" });',
    '        process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", error: usageLimitError } } }) + "\\n");',
    '        if (activeTurn?.id === turnId) activeTurn = null;',
    '        if (activeTurnId === turnId) activeTurnId = null;',
    '      }, turnDelayMs + 10);',
    '      continue;',
    '    }',
    '    setTimeout(() => {',
    '      process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: turnId } } }) + "\\n");',
    '    }, turnDelayMs + 5);',
    '    setTimeout(() => {',
    '      process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: messageId, delta: `reply:${promptText}:` } }) + "\\n");',
    '    }, turnDelayMs + 6);',
    '    setTimeout(() => {',
    '      if (activeTurn?.id === turnId) activeTurn.items.push({ id: messageId, type: "agentMessage", text: `reply:${promptText}:done` });',
    '      process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: messageId, type: "agentMessage", text: `reply:${promptText}:done` } } }) + "\\n");',
    '    }, turnDelayMs + 7);',
    '    const completeTurn = async () => {',
    '      if (nativeGoalSuccessorEnabled && !nativeGoalSuccessorLaunched && nativeGoalActivationAt === 0) {',
    '        setTimeout(completeTurn, 25);',
    '        return;',
    '      }',
    '      if (nativeGoalSuccessorEnabled && !nativeGoalSuccessorLaunched && Date.now() < nativeGoalActivationAt + 1000) {',
    '        setTimeout(completeTurn, 25);',
    '        return;',
    '      }',
    '      await appendHarnessEvent("happier/test/turn/completed", { threadId, turnId, promptText, status: "completed" });',
    '      process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId } } }) + "\\n");',
    '      if (activeTurn?.id === turnId) { completedTurns.push(activeTurn); activeTurn = null; }',
    '      if (activeTurnId === turnId) activeTurnId = null;',
    '      if (nativeGoalSuccessorEnabled && !nativeGoalSuccessorLaunched && currentGoal?.status === "active") {',
    '        nativeGoalSuccessorLaunched = true;',
    '        const successorTurnId = "turn-native-goal-successor";',
    '        const successorMessageId = "msg-native-goal-successor";',
    '        activeTurnId = successorTurnId;',
    '        activeTurn = { id: successorTurnId, threadId, items: [] };',
    '        await appendHarnessEvent("happier/test/goal-successor/started", { threadId, turnId: successorTurnId });',
    '        process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: successorTurnId } } }) + "\\n");',
    '        setTimeout(() => {',
    '          process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId, turnId: successorTurnId, itemId: successorMessageId, delta: "native-goal-successor-visible" } }) + "\\n");',
    '        }, 25);',
    '        setTimeout(() => {',
    '          const text = "native-goal-successor-visible:done";',
    '          if (activeTurn?.id === successorTurnId) activeTurn.items.push({ id: successorMessageId, type: "agentMessage", text });',
    '          process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId, turnId: successorTurnId, item: { id: successorMessageId, type: "agentMessage", text } } }) + "\\n");',
    '        }, 50);',
    '        setTimeout(async () => {',
    '          if (currentGoal?.status === "active") {',
    '            currentGoal = { ...currentGoal, status: "complete", updatedAt: new Date().toISOString() };',
    '            await persistGoal();',
    '            process.stdout.write(JSON.stringify({ method: "thread/goal/updated", params: { threadId, turnId: successorTurnId, goal: currentGoal } }) + "\\n");',
    '          }',
    '          await appendHarnessEvent("happier/test/goal-successor/completed", { threadId, turnId: successorTurnId });',
    '          process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: successorTurnId } } }) + "\\n");',
    '          if (activeTurn?.id === successorTurnId) { completedTurns.push(activeTurn); activeTurn = null; }',
    '          if (activeTurnId === successorTurnId) activeTurnId = null;',
    '        }, nativeGoalSuccessorDelayMs);',
    '      }',
    '    };',
    '    setTimeout(completeTurn, turnDelayMs + 10);',
    '    continue;',
    '  }',
    '  if (msg.method === "turn/steer") {',
    '    const threadId = typeof msg.params?.threadId === "string" ? msg.params.threadId : "thread-started";',
    '    const expectedTurnId = typeof msg.params?.expectedTurnId === "string" ? msg.params.expectedTurnId : (typeof msg.params?.turnId === "string" ? msg.params.turnId : null);',
    '    if (!expectedTurnId || expectedTurnId !== activeTurnId) {',
    '      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "turn/steer requires active expectedTurnId" } }) + "\\n");',
    '      continue;',
    '    }',
    '    const steerInput = Array.isArray(msg.params?.input) ? msg.params.input : [];',
    '    const steerText = String(steerInput[0]?.text ?? "");',
    '    if (activeTurn?.id === expectedTurnId) activeTurn.items.push({ type: "userMessage", text: steerText });',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId, turn: { id: expectedTurnId } } }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "review/start") {',
    '    turnCounter += 1;',
    '    const threadId = msg.params?.threadId ?? "thread-started";',
    '    const reviewThreadId = msg.params?.delivery === "detached" ? `review-thread-${turnCounter}` : threadId;',
    '    const turnId = `review-turn-${turnCounter}`;',
    '    const enteredId = `review-entered-${turnCounter}`;',
    '    const exitedId = `review-exited-${turnCounter}`;',
    '    const messageId = `review-msg-${turnCounter}`;',
    '    const reviewLabel = readReviewLabel(msg.params?.target);',
    '    const reviewText = buildFakeReviewText();',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, reviewThreadId } }) + "\\n");',
    '    setTimeout(() => {',
    '      process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: reviewThreadId, turnId, item: { id: enteredId, type: "enteredReviewMode", review: reviewLabel } } }) + "\\n");',
    '    }, turnDelayMs + 5);',
    '    setTimeout(() => {',
    '      process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: reviewThreadId, turnId, item: { id: enteredId, type: "enteredReviewMode", review: reviewLabel } } }) + "\\n");',
    '    }, turnDelayMs + 6);',
    '    setTimeout(() => {',
    '      process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: reviewThreadId, turnId, item: { id: exitedId, type: "exitedReviewMode", review: reviewLabel } } }) + "\\n");',
    '    }, turnDelayMs + 7);',
    '    setTimeout(() => {',
    '      process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: reviewThreadId, turnId, item: { id: exitedId, type: "exitedReviewMode", review: reviewText } } }) + "\\n");',
    '    }, turnDelayMs + 8);',
    '    setTimeout(() => {',
    '      process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: reviewThreadId, turnId, item: { id: messageId, type: "agentMessage", text: reviewText } } }) + "\\n");',
    '    }, turnDelayMs + 9);',
    '    setTimeout(() => {',
    '      process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: reviewThreadId, turn: { id: turnId } } }) + "\\n");',
    '    }, turnDelayMs + 10);',
    '    continue;',
    '  }',
    '  if (msg.method === "thread/rollback") {',
    '    const numTurns = Number(msg.params?.numTurns);',
    '    if (!Number.isInteger(numTurns) || numTurns < 1 || typeof msg.params?.threadId !== "string" || msg.params.threadId.length === 0) {',
    '      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "thread/rollback requires { threadId, numTurns >= 1 }" } }) + "\\n");',
    '      continue;',
    '    }',
    '    if (activeTurn?.threadId === msg.params.threadId) {',
    '      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "Cannot roll back while an active turn is running" } }) + "\\n");',
    '      continue;',
    '    }',
    '    const retainedTurns = [];',
    '    let remainingToDrop = numTurns;',
    '    for (let index = completedTurns.length - 1; index >= 0; index -= 1) {',
    '      const turn = completedTurns[index];',
    '      if (turn.threadId === msg.params.threadId && remainingToDrop > 0) {',
    '        remainingToDrop -= 1;',
    '        continue;',
    '      }',
    '      retainedTurns.unshift(turn);',
    '    }',
    '    completedTurns = retainedTurns;',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: msg.params.threadId } }) + "\\n");',
    '    continue;',
    '  }',
    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
    '}',
  ].join('\n');
  await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
  return scriptPath;
}

export async function readFakeCodexAppServerRequestLog(requestLogPath: string): Promise<FakeCodexAppServerRequest[]> {
  if (!existsSync(requestLogPath)) return [];
  const raw = await readFile(requestLogPath, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as FakeCodexAppServerRequest];
      } catch {
        return [];
      }
    });
}

export type StartedCodexAppServerRemoteHarness = Readonly<{
  server: StartedServer;
  serverBaseUrl: string;
  auth: TestAuth;
  cliHome: string;
  workspaceDir: string;
  secret: Uint8Array;
  sessionId: string;
  requestLogPath: string;
  fakeAppServerPath: string;
  readySession: SessionV2;
  stopRuntime: () => Promise<void>;
  stop: () => Promise<void>;
}>;

export async function startCodexAppServerRemoteHarness(params: Readonly<{
  testDir: string;
  runId: string;
  testName: string;
  goalSetBehavior?: 'objectiveRequired' | 'nativePartial';
  cliEnvOverrides?: NodeJS.ProcessEnv;
  manifestEnv?: Record<string, string>;
  metadataOverrides?: Record<string, unknown>;
  accountSettings?: unknown;
  waitForPublishedMetadata?: boolean;
}>): Promise<StartedCodexAppServerRemoteHarness> {
  const startedAt = new Date().toISOString();
  const server = await startServerLight({
    testDir: params.testDir,
    dbProvider: 'sqlite',
    extraEnv: {
      HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
    },
  });

  const serverBaseUrl = server.baseUrl;
  const auth = await createTestAuth(serverBaseUrl);
  const cliHome = resolve(join(params.testDir, 'cli-home'));
  const workspaceDir = resolve(join(params.testDir, 'workspace'));
  await mkdir(cliHome, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const secret = Uint8Array.from(randomBytes(32));
  await seedCliAuthForServer({ cliHome, serverUrl: serverBaseUrl, token: auth.token, secret });
  if (params.accountSettings !== undefined) {
    await upsertEncryptedAccountSettingsV2({
      baseUrl: serverBaseUrl,
      token: auth.token,
      secret,
      settings: params.accountSettings,
    });
  }

  const metadataCiphertextBase64 = encryptLegacyBase64(
    {
      path: workspaceDir,
      host: 'e2e',
      name: params.testName,
      createdAt: Date.now(),
      permissionMode: 'default',
      permissionModeUpdatedAt: 1000,
      codexBackendMode: 'appServer',
      ...params.metadataOverrides,
    },
    secret,
  );

  const { sessionId } = await createSessionWithCiphertexts({
    baseUrl: serverBaseUrl,
    token: auth.token,
    tag: `e2e-${params.testName}-${randomUUID()}`,
    metadataCiphertextBase64,
    agentStateCiphertextBase64: null,
  });

  const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });
  const requestLogPath = resolve(join(params.testDir, 'fake-codex-app-server.requests.jsonl'));
  const fakeAppServer = await writeFakeCodexAppServerScript({
    dir: params.testDir,
    requestLogPath,
    goalSetBehavior: params.goalSetBehavior,
  });

  writeTestManifestForServer({
    testDir: params.testDir,
    server,
    startedAt,
    runId: params.runId,
    testName: params.testName,
    sessionIds: [sessionId],
    env: params.manifestEnv ?? {},
  });

  const cliEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    HAPPIER_VARIANT: 'dev',
    HAPPIER_HOME_DIR: cliHome,
    HAPPIER_SERVER_URL: serverBaseUrl,
    HAPPIER_WEBAPP_URL: serverBaseUrl,
    HAPPIER_SESSION_ATTACH_FILE: attachFile,
    HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '2000',
    ...params.cliEnvOverrides,
  };

  const proc: SpawnedProcess = spawnLoggedProcess({
    command: yarnCommand(),
    args: [
      '-s',
      'workspace',
      '@happier-dev/cli',
      'dev',
      'codex',
      '--existing-session',
      sessionId,
      '--started-by',
      'terminal',
      '--happy-starting-mode',
      'remote',
    ],
    cwd: repoRootDir(),
    env: cliEnv,
    stdoutPath: resolve(join(params.testDir, 'cli.stdout.log')),
    stderrPath: resolve(join(params.testDir, 'cli.stderr.log')),
  });

  let runtimeStopped = false;
  const stopRuntime = async (): Promise<void> => {
    if (runtimeStopped) return;
    runtimeStopped = true;
    await proc.stop().catch(() => {});
    await stopDaemonFromHomeDir(cliHome).catch(() => {});
  };

  const stop = async (): Promise<void> => {
    await stopRuntime();
    await server.stop().catch(() => {});
  };

  try {
    return {
      server,
      serverBaseUrl,
      auth,
      cliHome,
      workspaceDir,
      secret,
      sessionId,
      requestLogPath,
      fakeAppServerPath: fakeAppServer,
      readySession: await fetchSessionV2(serverBaseUrl, auth.token, sessionId),
      stopRuntime,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
