import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { selectMcpRegistryServerTransportV1 } from '@happier-dev/protocol/mcp/servers/registry/mapMcpRegistryServerV1';
import type {
  McpRegistryArgumentV1,
  McpRegistryInputV1,
  McpRegistryServerV1,
} from '@happier-dev/protocol/registries';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';
import { MCP_SERVER_CATALOG_SUGGESTIONS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import type { PublicActionResultById } from '@happier-dev/protocol/actions/actionSpecs';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';

export type McpAddSuggestionRow = Readonly<{
  suggestionId: (typeof MCP_SERVER_CATALOG_SUGGESTIONS_V1)[number]['id'];
  title: string;
  description?: string;
  // Suggestions have no registry source, pin, publisher or update lifecycle.
  sourceId?: never;
  itemId?: never;
  version?: never;
  publisher?: never;
  flags?: never;
  brandMark?: never;
}>;
export type McpAddCatalogRow = RegistryCatalogItemSummary | McpAddSuggestionRow;

export function isMcpAddSuggestion(row: McpAddCatalogRow): row is McpAddSuggestionRow {
  return 'suggestionId' in row;
}

export function mcpAddRowKey(row: McpAddCatalogRow): string {
  return isMcpAddSuggestion(row) ? `suggestion:${row.suggestionId}` : `${row.sourceId}|${row.itemId}`;
}

/** Discovery is admitted by the Action's options; URL and auth details stay at the catalog owner. */
export function mcpAddSuggestionRows(options: PublicActionResultById['action.options.resolve']['options']): readonly McpAddSuggestionRow[] {
  return options.flatMap(option => {
    const suggestion = MCP_SERVER_CATALOG_SUGGESTIONS_V1.find(candidate => candidate.id === option.value);
    return suggestion && !option.disabled ? [{ suggestionId: suggestion.id, title: option.label,
      ...(option.description ? { description: option.description } : {}) }] : [];
  });
}

export function buildMcpSuggestionDetailModel(row: McpAddSuggestionRow): McpAddDetailModel {
  const suggestion = MCP_SERVER_CATALOG_SUGGESTIONS_V1.find(candidate => candidate.id === row.suggestionId)!;
  return { supported: true, transport: 'remote', runs: suggestion.oauth ? 'remoteSignIn' : 'remote',
    remoteHost: hostOf(suggestion.url), fields: [], signIn: suggestion.oauth };
}

/** How one declared input is edited: an env name or header name over the shared rows editor, else a plain field. */
export type McpAddFieldPresentation = 'env' | 'header' | 'text';

export type McpAddField = Readonly<{
  /** The name the registry mapper reads the supplied value by. */
  key: string;
  presentation: McpAddFieldPresentation;
  description?: string;
  required: boolean;
  secret: boolean;
  choices?: readonly string[];
  defaultValue?: string;
}>;

/** What runs where, as the details say it. */
export type McpAddRuns = 'remoteSignIn' | 'remote' | 'npx' | 'uvx' | 'docker';

export type McpAddDetailModel =
  | Readonly<{ supported: false }>
  | Readonly<{
      supported: true;
      transport: 'remote' | 'local';
      runs: McpAddRuns;
      /** The remote's host, for "Opens <host> in your browser to approve." */
      remoteHost: string | null;
      fields: readonly McpAddField[];
      /** The add chooses OAuth for the remote (a remote that declares no key to send). */
      signIn: boolean;
    }>;

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

function presentationOf(input: McpRegistryInputV1): McpAddFieldPresentation {
  if (input.target === 'env' && ENV_NAME.test(input.name)) return 'env';
  if (input.target === 'header' && HEADER_NAME.test(input.name))
    return 'header';
  return 'text';
}

function fieldOf(input: McpRegistryInputV1): McpAddField[] {
  // A templated value is asked per variable: the mapper reads each variable by its own name.
  if (input.value !== undefined && input.variables) {
    return Object.entries(input.variables).map(([name, variable]) => ({
      key: name,
      presentation: 'text' as const,
      ...(variable.description ? { description: variable.description } : {}),
      required:
        variable.required &&
        variable.value === undefined &&
        variable.default === undefined,
      secret: variable.secret,
      ...(variable.choices ? { choices: variable.choices } : {}),
      ...((variable.value ?? variable.default) !== undefined
        ? { defaultValue: (variable.value ?? variable.default)! }
        : {}),
    }));
  }
  // A fixed value is part of the server, not asked.
  if (input.value !== undefined) return [];
  return [
    {
      key: input.name,
      presentation: presentationOf(input),
      ...(input.description ? { description: input.description } : {}),
      required: input.required && input.default === undefined,
      secret: input.secret,
      ...(input.choices ? { choices: input.choices } : {}),
      ...(input.default !== undefined ? { defaultValue: input.default } : {}),
    },
  ];
}

function argumentFields(
  values: readonly McpRegistryArgumentV1[],
): McpAddField[] {
  return values.flatMap((arg, index): McpAddField[] => {
    if (arg.secret || arg.value !== undefined) return [];
    if (!arg.required && arg.default === undefined) return [];
    return [
      {
        key: arg.name ?? arg.valueHint ?? `argument:${index}`,
        presentation: 'text',
        ...(arg.description ? { description: arg.description } : {}),
        required: arg.required && arg.default === undefined,
        secret: false,
        ...(arg.choices ? { choices: arg.choices } : {}),
        ...(arg.default !== undefined ? { defaultValue: arg.default } : {}),
      },
    ];
  });
}

function hostOf(url: string): string | null {
  try {
    return new URL(url.replace(/\{[^{}]+\}/gu, 'x')).host || null;
  } catch {
    return null;
  }
}

/**
 * A registry server's details (lab ma-D / ma-N): the one transport the registry mapper would choose, what it asks for,
 * and what runs where. A remote that declares no key to send signs in once through OAuth (a choice the add supplies,
 * never a fact read off the registry); otherwise a package runs on the machines, preferring npm, then pypi, then docker.
 */
export function buildMcpAddDetailModel(
  server: McpRegistryServerV1,
): McpAddDetailModel {
  const remote = server.remotes[0];
  const signIn =
    remote !== undefined && remote.inputs.every((input) => !input.required);
  let selected: ReturnType<typeof selectMcpRegistryServerTransportV1>;
  try {
    selected = selectMcpRegistryServerTransportV1(server, { oauth: signIn });
  } catch {
    return { supported: false };
  }
  if (selected.transport === 'stdio') {
    const command = selected.stdio.command;
    return {
      supported: true,
      transport: 'local',
      runs: command === 'npx' ? 'npx' : command === 'uvx' ? 'uvx' : 'docker',
      remoteHost: null,
      fields: [
        ...selected.inputs.flatMap(fieldOf),
        ...argumentFields(selected.runtimeArguments ?? []),
        ...argumentFields(selected.arguments),
      ],
      signIn: false,
    };
  }
  const useSignIn = signIn && selected.remote.url === remote?.url;
  return {
    supported: true,
    transport: 'remote',
    runs: useSignIn ? 'remoteSignIn' : 'remote',
    remoteHost: hostOf(selected.remote.url),
    fields: selected.inputs.flatMap(fieldOf),
    signIn: useSignIn,
  };
}

export type McpAddValues = Readonly<Record<string, ValueRefV1>>;

/** Rows start where the person needs to act: a key waits for a Saved Secret, other values start at their default. */
export function seedMcpAddValues(fields: readonly McpAddField[]): McpAddValues {
  return Object.fromEntries(
    fields.map((field): [string, ValueRefV1] => [
      field.key,
      field.secret
        ? { t: 'savedSecret', secretId: '' }
        : { t: 'literal', v: field.defaultValue ?? field.choices?.[0] ?? '' },
    ]),
  );
}

function isFilled(value: ValueRefV1 | undefined): boolean {
  if (value === undefined) return false;
  if (value.t === 'literal') return value.v.trim().length > 0;
  if (value.t === 'savedSecret') return value.secretId.length > 0;
  return true;
}

/** The required inputs still waiting for a value: while any remain, Add says why and stays off. */
export function missingMcpAddFields(
  fields: readonly McpAddField[],
  values: McpAddValues,
): readonly McpAddField[] {
  return fields.filter(
    (field) => field.required && !isFilled(values[field.key]),
  );
}

/** What `mcp.servers.create` receives: only the values the person gave. */
export function mcpAddCreateInputs(
  values: McpAddValues,
): Record<string, ValueRefV1> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => isFilled(value)),
  );
}

/** The catalog entry an earlier add from this registry item created, so the details offer Open instead of Add. */
export function findAddedMcpServer(
  servers: readonly McpServerCatalogEntryV1[],
  pointer: Readonly<{ sourceId: string; itemId: string }> | McpAddSuggestionRow,
): McpServerCatalogEntryV1 | null {
  if ('suggestionId' in pointer) return null;
  return (
    servers.find(
      (server) =>
        server.origin?.kind === 'registry' &&
        server.origin.provenance.sourceId === pointer.sourceId &&
        server.origin.provenance.itemId === pointer.itemId,
    ) ?? null
  );
}
