import {
  materializeExternalSessionSourceInstances,
  parseExternalSessionsSourceForDeclaration,
  type ExternalSessionsSource,
  type PluginBackendExternalSessionSourceDeclarationV1,
} from '@happier-dev/protocol';

/**
 * The one host rule for caller-chosen external-session source fields.
 *
 * `materializeExternalSessionSourceInstances` is the single owner that turns a
 * declaration plus the operator's account settings into the concrete sources a
 * user may pick, and the browse surface builds its picker from exactly that
 * owner. This is the daemon half of the same contract: a field whose value that
 * materialization determines — the read root an Agent resolves from its ambient
 * environment, or the root an operator configured through an agent setting — is
 * host-determined, so a request may omit it but may not name a different one.
 *
 * Without the rule that value travels from the request straight into the root an
 * Agent leaf scans and into the media read roots the host then grants, so a
 * request can address a directory neither the machine's environment nor the
 * account's settings ever named. Selector fields the materialization does not
 * determine (a project, conversation or session identifier) stay caller-chosen
 * and remain the Agent leaf's containment responsibility.
 *
 * Each Agent's declaration already carries whether divergence from the ambient
 * value is legitimate: an `agentSetting`/`agentSettingOverride` instance means
 * the operator can configure another root, and its absence means the ambient one
 * is the only authorized root. No Agent declares a separate permission for this.
 */

type SourceDeclaration = Pick<
  PluginBackendExternalSessionSourceDeclarationV1,
  'sourceKind' | 'schema' | 'key' | 'instances'
>;

export type CallerChosenExternalSessionSourceFieldsAdmission =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; field: string }>;

const ADMITTED: CallerChosenExternalSessionSourceFieldsAdmission = Object.freeze({ ok: true });

function readSuppliedFieldNames(source: ExternalSessionsSource): readonly string[] {
  return Object.keys(source).filter((field) => {
    if (field === 'kind') return false;
    const value = source[field];
    if (value === undefined || value === null) return false;
    return typeof value === 'string' ? value.trim().length > 0 : true;
  });
}

/**
 * The fields the declaration lets an operator configure. Each
 * `agentSetting`/`agentSettingOverride` instance names exactly one, and that
 * instance materializing is the only thing that authorizes a caller-named value
 * for it.
 */
function agentSettingOwnedFields(declaration: SourceDeclaration): ReadonlySet<string> {
  return new Set(
    (declaration.instances ?? [])
      .flatMap((instance) => (
        instance.kind === 'agentSetting' || instance.kind === 'agentSettingOverride'
          ? [instance.field]
          : []
      )),
  );
}

/**
 * The declaration-owned literals that separate one instance family from another
 * (a user home against a connected-service home, a managed endpoint against a
 * configured base URL). A request that does not carry them belongs to a
 * different family, so that family's authorized values do not govern it.
 */
function instanceDiscriminatorFields(params: Readonly<{
  settingFields: ReadonlySet<string>;
  instanceSource: Readonly<Record<string, unknown>>;
}>): readonly string[] {
  return Object.keys(params.instanceSource).filter(
    (field) => field !== 'kind' && !params.settingFields.has(field),
  );
}

/**
 * The instances this boundary materializes that could govern the request at
 * all. The discriminators are the declaration's own literals, so this is
 * decided on the request's own value: it needs nothing the Agent leaf produces.
 */
function resolveApplicableInstances(params: Readonly<{
  declaration: SourceDeclaration;
  requestedSource: ExternalSessionsSource;
  agentSettings: unknown;
  activeServerId: string | null;
}>): Readonly<{
  supplied: readonly string[];
  settingFields: ReadonlySet<string>;
  applicable: readonly Readonly<{ source: Readonly<Record<string, unknown>> }>[];
}> {
  // A connected-service instance's concrete identity comes from the Account
  // profile, which this boundary does not read, so no such instance
  // materializes here. Those fields name an entry in a host-owned home
  // namespace rather than a free path, and the owning Agent resolves them
  // against that namespace, so they stay leaf-verified.
  const materialized = materializeExternalSessionSourceInstances({
    declaration: params.declaration,
    agentSettings: params.agentSettings,
    activeServerId: params.activeServerId,
  });
  const settingFields = agentSettingOwnedFields(params.declaration);
  return {
    supplied: readSuppliedFieldNames(params.requestedSource),
    settingFields,
    applicable: materialized.instances.filter((instance) => (
      instanceDiscriminatorFields({
        settingFields,
        instanceSource: instance.source,
      }).every((field) => params.requestedSource[field] === instance.source[field])
    )),
  };
}

/**
 * The half of the rule that the request's own value already decides, so the
 * daemon can run it before it hands the source to the Agent leaf.
 *
 * When no instance this boundary materializes governs the request, there is no
 * authorized value to compare against and nothing to canonicalize: for a field
 * an agent setting owns, that absence IS the answer rather than an abstention.
 * The instance is missing precisely because the operator configured no such
 * source, so Happier manages and owns the one it declared and the request may
 * not name another. Admitting it here is what lets a request hand the daemon a
 * base URL for a server nobody configured — and the daemon supervises the
 * attach service for that address, so deciding this only after the leaf has
 * canonicalized the source means the address is health-probed before it is
 * refused. Refusing an address the daemon has already dialed is not refusing
 * it.
 *
 * Any other field belongs to a family whose concrete identity this boundary
 * does not materialize — a connected-service home resolves against the Account
 * profile the daemon does not read here — and stays the Agent leaf's
 * containment responsibility.
 *
 * The comparison against an authorized instance stays in
 * {@link admitCallerChosenExternalSessionSourceFields}, because it is only
 * meaningful on canonicalized values: a configured `http://host:4096/` and a
 * requested `http://host:4096` are the same server, and comparing the raw
 * spellings would refuse the operator's own reuse flow.
 */
export function admitCallerChosenExternalSessionSourceFieldsOnRequestedValue(params: Readonly<{
  declaration: SourceDeclaration;
  requestedSource: ExternalSessionsSource;
  agentSettings: unknown;
  activeServerId: string | null;
}>): CallerChosenExternalSessionSourceFieldsAdmission {
  const { supplied, settingFields, applicable } = resolveApplicableInstances(params);
  if (supplied.length === 0 || applicable.length > 0) return ADMITTED;
  const settingOwned = supplied.find((field) => settingFields.has(field));
  return settingOwned === undefined
    ? ADMITTED
    : Object.freeze({ ok: false, field: settingOwned });
}

export async function admitCallerChosenExternalSessionSourceFields(params: Readonly<{
  declaration: SourceDeclaration;
  /** The request's source, before the Agent leaf canonicalized it. */
  requestedSource: ExternalSessionsSource;
  /** The same source after the Agent leaf canonicalized it. */
  canonicalSource: ExternalSessionsSource;
  agentSettings: unknown;
  activeServerId: string | null;
  /** The Agent leaf's canonicalization, used to resolve an authorized instance. */
  canonicalize: (source: ExternalSessionsSource) => Promise<ExternalSessionsSource | null>;
}>): Promise<CallerChosenExternalSessionSourceFieldsAdmission> {
  const ungoverned = admitCallerChosenExternalSessionSourceFieldsOnRequestedValue(params);
  if (!ungoverned.ok) return ungoverned;

  const { supplied, applicable } = resolveApplicableInstances(params);
  // Either the request supplied nothing to govern, or the pre-canonicalization
  // half above already ruled on every field an instance could have governed.
  if (supplied.length === 0 || applicable.length === 0) return ADMITTED;

  let refusedField: string | null = null;
  for (const instance of applicable) {
    const authorizedInput = parseExternalSessionsSourceForDeclaration(
      params.declaration,
      instance.source,
    );
    const authorized = authorizedInput
      ? await params.canonicalize(authorizedInput).catch(() => null)
      : null;
    if (!authorized) {
      // An Agent that cannot resolve its own authorized instance yields no
      // authorized value to compare against, which is not permission to use the
      // one the request named.
      refusedField ??= supplied[0] ?? params.declaration.sourceKind;
      continue;
    }
    const mismatched = supplied
      .filter((field) => field in authorized && authorized[field] !== undefined)
      .find((field) => params.canonicalSource[field] !== authorized[field]);
    if (!mismatched) return ADMITTED;
    refusedField ??= mismatched;
  }

  return refusedField === null ? ADMITTED : Object.freeze({ ok: false, field: refusedField });
}
