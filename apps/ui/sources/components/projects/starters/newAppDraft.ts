import { projectCheckoutParentPath } from '../activation/projectOpenChoices';

/**
 * The New app flow's typed boundary to `projects.starters.create` (Plan 60 §3.2, contract posted by
 * STARTER-ACTION-1110 "For UI lanes"). The Action owns every effect; this module only assembles the
 * reviewed operands and reads its result into one state with one next step.
 */
export type StarterCreateInput = Readonly<{
  serverId: string;
  machineId: string;
  requestKey: string;
  starterId: string;
  description: string;
  destinationParentPath: string;
  destinationDirectoryName: string;
  repository: Readonly<{
    owner: string;
    name: string;
    visibility: 'private' | 'public';
  }>;
}>;

export type StarterSessionHandoff = Readonly<{
  machineId: string;
  directory: string;
  initialMessage: string;
}>;

export type StarterCreateOutcome =
  | Readonly<{
      kind: 'created';
      projectId: string;
      repositoryUrl: string | null;
      handoff: StarterSessionHandoff;
    }>
  | Readonly<{ kind: 'needsScmAccount' }>
  | Readonly<{ kind: 'outcomeUnknown'; repositoryUrl: string | null }>
  | Readonly<{
      kind: 'failed';
      phase: string | null;
      code: string;
      repositoryCreated: boolean;
      remediation: string | null;
    }>;

export type NewAppDraft = Readonly<{
  starterId: string | null;
  description: string;
  name: string;
  machineId: string | null;
}>;

/** "Rye & Co. orders" → "rye-co-orders": the name a person would give the repository themselves. */
export function deriveRepositoryName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/** The exact operands the review shows, or null while one of them is still missing. */
export function buildStarterCreateInput(
  draft: NewAppDraft,
  facts: Readonly<{
    serverId: string;
    homeDir: string | null;
    owner: string | null;
    requestKey: string;
  }>,
): StarterCreateInput | null {
  const description = draft.description.trim();
  const name = deriveRepositoryName(draft.name);
  if (
    !draft.starterId ||
    !description ||
    !name ||
    !draft.machineId ||
    !facts.homeDir ||
    !facts.owner
  )
    return null;
  return {
    serverId: facts.serverId,
    machineId: draft.machineId,
    requestKey: facts.requestKey,
    starterId: draft.starterId,
    description,
    destinationParentPath: projectCheckoutParentPath(facts.homeDir),
    destinationDirectoryName: name,
    repository: { owner: facts.owner, name, visibility: 'private' },
  };
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export function readStarterCreateOutcome(
  result: unknown,
): StarterCreateOutcome {
  const value = (result && typeof result === 'object' ? result : {}) as Record<
    string,
    unknown
  >;
  if (value.kind === 'created') {
    const handoff = (
      value.sessionHandoff && typeof value.sessionHandoff === 'object'
        ? value.sessionHandoff
        : {}
    ) as Record<string, unknown>;
    const machineId = text(handoff.machineId);
    const directory = text(handoff.directory);
    const initialMessage = text(handoff.initialMessage);
    const projectId = text(value.projectId);
    if (machineId && directory && initialMessage && projectId) {
      return {
        kind: 'created',
        projectId,
        repositoryUrl: text(value.repositoryUrl),
        handoff: { machineId, directory, initialMessage },
      };
    }
  }
  if (value.kind === 'failed' || value.kind === 'partial') {
    const code = text(value.code) ?? 'starter_create_failed';
    if (code === 'scm_account_required') return { kind: 'needsScmAccount' };
    if (code === 'outcome_unknown')
      return {
        kind: 'outcomeUnknown',
        repositoryUrl: text(value.repositoryUrl),
      };
    return {
      kind: 'failed',
      phase: text(value.phase),
      code,
      repositoryCreated: text(value.repositoryUrl) !== null,
      // The SCM owner's remediation carries its own label (Choose another name, Connect GitHub…).
      remediation:
        value.remediation && typeof value.remediation === 'object'
          ? text((value.remediation as Record<string, unknown>).label)
          : null,
    };
  }
  return {
    kind: 'failed',
    phase: null,
    code: 'invalid_result',
    repositoryCreated: false,
    remediation: null,
  };
}

/**
 * One create intent per reviewed draft: the same review retried reuses its key (the Action's owners
 * then never create twice); any reviewed operand that changes is a new intent with a new key.
 */
export function createStarterIntentKeys(mint: () => string) {
  let current: Readonly<{ signature: string; key: string }> | null = null;
  return (reviewed: Readonly<Record<string, unknown>>): string => {
    const signature = JSON.stringify(Object.keys(reviewed).sort().map((name) => [name, reviewed[name]]));
    if (current?.signature !== signature) current = { signature, key: mint() };
    return current.key;
  };
}
