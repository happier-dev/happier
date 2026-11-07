import { mcpImportValueInputIdV1 } from '@happier-dev/protocol/mcp/servers/import/parseMcpServerImportV1';
import type {
  McpImportPreviewV1,
  McpImportValuesV1,
} from '@happier-dev/protocol/mcp/servers/import/mcpServerImportV1';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import type { ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { createStore } from 'zustand/vanilla';

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

/** One value the paste leaves open, asked with a value type (Saved Secret, Text, From the machine). */
export type McpPasteAsk = Readonly<{
  inputId: string;
  key: string;
  secret: boolean;
  description?: string;
}>;

export type McpPasteServerModel = Readonly<{
  name: string;
  title: string;
  transport: 'stdio' | 'http' | 'sse';
  auth?: McpImportPreviewV1['servers'][number]['auth'];
  /** Values asked over the shared rows editor, by where they go. */
  env: readonly McpPasteAsk[];
  headers: readonly McpPasteAsk[];
  /** A key pasted as plain text: saved as a Saved Secret, never kept in the config. */
  literalSecrets: readonly Readonly<{
    inputId: string;
    key: string;
    secretName: string;
  }>[];
}>;

export type McpPastePreviewModel = Readonly<{
  servers: readonly McpPasteServerModel[];
  /** Values the rows editor can't name (a VS Code input, an unusual key): one plain field each. */
  fields: readonly McpPasteAsk[];
  duplicates: readonly Readonly<{ name: string; inCatalog: boolean }>[];
  errors: readonly string[];
  warnings: readonly string[];
}>;

/** The preview, shaped for the details: per server, which values are asked where. */
export function buildMcpPastePreviewModel(
  preview: McpImportPreviewV1,
): McpPastePreviewModel {
  const missing = new Map(
    preview.missingValues.map((input) => [input.inputId, input]),
  );
  const literal = new Set(
    preview.inputs
      .filter((input) => input.literalSecret === true)
      .map((input) => input.inputId),
  );
  const claimed = new Set<string>();
  const servers = preview.servers.map((server): McpPasteServerModel => {
    const title = server.title ?? server.name;
    const literalSecrets: {
      inputId: string;
      key: string;
      secretName: string;
    }[] = [];
    const asked = (
      target: 'env' | 'header',
      names: readonly string[],
      valid: RegExp,
    ): McpPasteAsk[] =>
      names.flatMap((key) => {
        const inputId = mcpImportValueInputIdV1(server.name, target, key);
        const input = missing.get(inputId);
        if (!input) return [];
        if (literal.has(inputId)) {
          claimed.add(inputId);
          literalSecrets.push({ inputId, key, secretName: title });
          return [];
        }
        if (!valid.test(key)) return [];
        claimed.add(inputId);
        return [
          {
            inputId,
            key,
            secret: input.secret,
            ...(input.description ? { description: input.description } : {}),
          },
        ];
      });
    const env = asked('env', server.envNames, ENV_NAME);
    const headers = asked('header', server.headerNames, HEADER_NAME);
    // Two keys in one server share its name: tell them apart.
    const named =
      literalSecrets.length > 1
        ? literalSecrets.map((secret) => ({
            ...secret,
            secretName: `${title} · ${secret.key}`,
          }))
        : literalSecrets;
    return {
      name: server.name,
      title,
      transport: server.transport,
      ...(server.auth ? { auth: server.auth } : {}),
      env,
      headers,
      literalSecrets: named,
    };
  });
  const fields = preview.missingValues
    .filter((input) => !claimed.has(input.inputId))
    .map((input): McpPasteAsk => ({
      inputId: input.inputId,
      key: input.title,
      secret: input.secret,
      ...(input.description ? { description: input.description } : {}),
    }));
  return {
    servers,
    fields,
    duplicates: preview.duplicates.map((duplicate) => ({
      name: duplicate.name,
      inCatalog: duplicate.serverId !== undefined,
    })),
    errors: preview.errors,
    warnings: preview.warnings,
  };
}

/** What the person answered: a value type per row, and plain text per field. Keys are the preview's input ids. */
export type McpPasteAnswers = Readonly<{
  rows: Readonly<Record<string, ValueRefV1>>;
  fields: Readonly<Record<string, string>>;
}>;

export const EMPTY_MCP_PASTE_ANSWERS: McpPasteAnswers = {
  rows: {},
  fields: {},
};

/** Live-only import draft. The modal retains it while the active Paste leaf owns its readers. */
export type McpPasteDraftState = Readonly<{
  text: string;
  preview: McpImportPreviewV1 | null;
  previewText: string | null;
  answers: McpPasteAnswers;
  retained: McpImportValuesV1;
  rules: ReachRulesV1;
  where: ReachRulesChangeV1 | undefined;
  busy: boolean;
  error: string | null;
  added: boolean;
}>;

export type McpPasteDraftStore = Readonly<{
  getSnapshot: () => McpPasteDraftState;
  subscribe: (listener: () => void) => () => void;
  update: (change: (current: McpPasteDraftState) => McpPasteDraftState) => void;
}>;

export function createMcpPasteDraftStore(initial: McpPasteDraftState): McpPasteDraftStore {
  const store = createStore<McpPasteDraftState>(() => initial);
  return {
    getSnapshot: store.getState,
    subscribe: store.subscribe,
    update: (change: (current: McpPasteDraftState) => McpPasteDraftState) => store.setState(change, true),
  };
}

/** A row starts where the person needs to act: a key waits for a Saved Secret, anything else for its text. */
export function seedMcpPasteRow(ask: McpPasteAsk): ValueRefV1 {
  return ask.secret
    ? { t: 'savedSecret', secretId: '' }
    : { t: 'literal', v: '' };
}

function rowValue(answers: McpPasteAnswers, ask: McpPasteAsk): ValueRefV1 {
  return answers.rows[ask.inputId] ?? seedMcpPasteRow(ask);
}

function isFilled(value: ValueRefV1): boolean {
  if (value.t === 'literal') return value.v.trim().length > 0;
  if (value.t === 'savedSecret') return value.secretId.length > 0;
  return true;
}

function allAsks(model: McpPastePreviewModel): readonly McpPasteAsk[] {
  return [
    ...model.servers.flatMap((server) => [...server.env, ...server.headers]),
    ...model.fields,
  ];
}

/** How many asked values still have no answer: while any remain, Add N says so and stays off. */
export function countOpenMcpPasteServerValues(server: McpPasteServerModel, answers: McpPasteAnswers): number {
  return [...server.env, ...server.headers].filter(ask => !isFilled(rowValue(answers, ask))).length;
}

export function countOpenMcpPasteValues(
  model: McpPastePreviewModel,
  answers: McpPasteAnswers,
): number {
  const openRows = model.servers.reduce((count, server) => count + countOpenMcpPasteServerValues(server, answers), 0);
  const openFields = model.fields.filter(
    (ask) => (answers.fields[ask.inputId] ?? '').trim().length === 0,
  ).length;
  return openRows + openFields;
}

/** The `values` the import receives: every asked value answered, and each pasted key saved as a Saved Secret. */
export function buildMcpPasteValues(
  model: McpPastePreviewModel,
  answers: McpPasteAnswers,
  retained: McpImportValuesV1 = {},
): McpImportValuesV1 {
  const values: Record<string, McpImportValuesV1[string]> = { ...retained };
  for (const server of model.servers) {
    for (const secret of server.literalSecrets) {
      if (values[secret.inputId] === undefined)
        values[secret.inputId] = {
          t: 'saveSecret',
          name: secret.secretName,
          kind: 'apiKey',
        };
    }
    for (const ask of [...server.env, ...server.headers]) {
      const value = rowValue(answers, ask);
      if (isFilled(value) && values[ask.inputId] === undefined)
        values[ask.inputId] = value;
    }
  }
  for (const ask of model.fields) {
    const text = (answers.fields[ask.inputId] ?? '').trim();
    if (!text || values[ask.inputId] !== undefined) continue;
    values[ask.inputId] = ask.secret
      ? { t: 'createSecret', name: ask.key, kind: 'apiKey', value: text }
      : { t: 'literal', v: text };
  }
  return values;
}

/** Every input id the model asks, for pruning answers that no longer belong to the preview. */
export function mcpPasteAskIds(
  model: McpPastePreviewModel,
): ReadonlySet<string> {
  return new Set(allAsks(model).map((ask) => ask.inputId));
}

const SERVER_CONTAINERS = [
  'mcpServers',
  'servers',
  'context_servers',
  'mcp',
] as const;
const URL_KEYS = ['url', 'httpUrl', 'serverUrl'] as const;

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function setTransportIn(
  node: Json,
  name: string,
  transport: 'http' | 'sse',
): boolean {
  for (const container of SERVER_CONTAINERS) {
    const inner = node[container];
    if (!isJson(inner)) continue;
    const server = inner[name];
    if (
      isJson(server) &&
      URL_KEYS.some((key) => typeof server[key] === 'string')
    ) {
      server.transport = transport;
      return true;
    }
    if (setTransportIn(inner, name, transport)) return true;
  }
  return false;
}

/**
 * The remote transport is a prefilled, changeable choice (IR-102): flipping it writes `transport` explicitly into that
 * server's own entry of the pasted JSON, which the import parser honours before any vendor field. A pasted install
 * link has no JSON to write into; it returns null and the choice stays as read.
 */
export function withMcpPasteServerTransport(
  text: string,
  serverName: string,
  transport: 'http' | 'sse',
): string | null {
  if (!/^\s*\{/u.test(text)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isJson(parsed)) return null;
  const single = URL_KEYS.some((key) => typeof parsed[key] === 'string');
  if (single) parsed.transport = transport;
  else if (!setTransportIn(parsed, serverName, transport)) return null;
  return JSON.stringify(parsed, null, 2);
}
