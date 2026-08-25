import {
  findPluginDiagnosticSourceLocation,
  type PluginDiagnosticSourceLocation,
} from '@/plugins/validation/diagnostics/sourceLocation';
import {
  evaluatePluginAuthorSource,
  resolvePluginAuthorSourceEntrypoint,
  type EvaluatedPluginAuthorSource,
  type PluginAuthorSourceEntry,
} from './sourceModule';
import {
  isPluginAuthorRootMaterialized,
  preparePluginAuthorDependencies,
  type PluginAuthorDependencyPreparationResult,
} from './toolchain';

/**
 * The doctor speaks the same author-source-location vocabulary as every other
 * plugin diagnostic producer; it does not own a second one.
 */
export type PluginAuthorDoctorDiagnosticLocation = PluginDiagnosticSourceLocation;

export type PluginAuthorDoctorDiagnostic = Readonly<{
  code:
    | 'plugin_author_dependency_preparation_failed'
    | 'plugin_author_evaluation_failed'
    | 'plugin_author_evaluation_slow';
  message: string;
  location?: PluginAuthorDoctorDiagnosticLocation;
}>;

/**
 * `(` terminates a path fragment as surely as `)` does: the compiler and the
 * package manager report `file(line,column)`, so a class that swallowed the
 * opening parenthesis redacted the line number away with the path and left the
 * author a dangling `<path>,3):`.
 */
const ABSOLUTE_PATH_FRAGMENT_PATTERN = /(?:[A-Za-z]:[\\/][^\s()\],:]*|\\\\[^\s()\],:]+|\/[^\s()\],:]+)/gu;

function redactAbsolutePathFragments(message: string): string {
  return message.replace(ABSOLUTE_PATH_FRAGMENT_PATTERN, '<path>');
}

function messageFromError(error: unknown): string {
  return redactAbsolutePathFragments(error instanceof Error ? error.message : String(error));
}

/**
 * Only the evaluated stack is searched: the doctor's own message text is
 * already path-redacted above, so a location must come from a real frame.
 */
function diagnosticLocationFromError(
  error: unknown,
  packageRoot: string | undefined,
): PluginAuthorDoctorDiagnosticLocation | undefined {
  if (!packageRoot || !(error instanceof Error) || typeof error.stack !== 'string') return undefined;
  return findPluginDiagnosticSourceLocation({
    texts: [error.stack],
    sourceRoot: packageRoot,
  }) ?? undefined;
}

function createErrorDiagnostic(
  code: Extract<PluginAuthorDoctorDiagnostic['code'],
    | 'plugin_author_dependency_preparation_failed'
    | 'plugin_author_evaluation_failed'>,
  prefix: string,
  error: unknown,
  packageRoot?: string,
): PluginAuthorDoctorDiagnostic {
  const location = diagnosticLocationFromError(error, packageRoot);
  return Object.freeze({
    code,
    message: `${prefix}: ${messageFromError(error)}`,
    ...(location === undefined ? {} : { location }),
  });
}

export type PluginAuthorDoctorResult =
  | Readonly<{
      ok: true;
      pluginId: string;
      version: string;
      entryPath: string;
      evaluationMs: number;
      canonicalManifestJson: string;
      diagnostics: readonly PluginAuthorDoctorDiagnostic[];
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginAuthorDoctorDiagnostic[];
    }>;

export async function runPluginAuthorDoctor(input: Readonly<{
  locator: string;
  resolveEntry?: (locator: string) => Promise<PluginAuthorSourceEntry>;
  prepareDependencies?: (input: Readonly<{
    projectRoot: string;
  }>) => Promise<PluginAuthorDependencyPreparationResult>;
  evaluate?: (input: Readonly<{ locator: string }>) => Promise<EvaluatedPluginAuthorSource>;
  nowMs?: () => number;
  slowEvaluationMs?: number;
}>): Promise<PluginAuthorDoctorResult> {
  let entry: PluginAuthorSourceEntry;
  try {
    entry = await (input.resolveEntry ?? resolvePluginAuthorSourceEntrypoint)(input.locator);
  } catch (error) {
    return Object.freeze({
      ok: false,
      diagnostics: Object.freeze([
        createErrorDiagnostic('plugin_author_evaluation_failed', 'Plugin author evaluation failed', error),
      ]),
    });
  }

  if (entry.kind === 'packageRoot' && !(await isPluginAuthorRootMaterialized(entry.packageRoot))) {
    let preparation: PluginAuthorDependencyPreparationResult;
    try {
      preparation = await (input.prepareDependencies ?? preparePluginAuthorDependencies)({
        projectRoot: entry.packageRoot,
      });
    } catch (error) {
      return Object.freeze({
        ok: false,
        diagnostics: Object.freeze([
          createErrorDiagnostic(
            'plugin_author_dependency_preparation_failed',
            'Plugin author dependency preparation failed',
            error,
            entry.packageRoot,
          ),
        ]),
      });
    }
    if (!preparation.ok) {
      // The toolchain already rebased this location onto the author's own
      // project root, so the projection carries it through instead of handing
      // back a redacted sentence with nowhere to look.
      const { source } = preparation.diagnostic;
      return Object.freeze({
        ok: false,
        diagnostics: Object.freeze([Object.freeze({
          code: 'plugin_author_dependency_preparation_failed' as const,
          message: redactAbsolutePathFragments(preparation.diagnostic.message),
          ...(source === undefined ? {} : { location: source }),
        })]),
      });
    }
  }

  const nowMs = input.nowMs ?? Date.now;
  const startedAt = nowMs();
  let evaluated: EvaluatedPluginAuthorSource;
  try {
    evaluated = await (input.evaluate ?? evaluatePluginAuthorSource)({ locator: input.locator });
  } catch (error) {
    return Object.freeze({
      ok: false,
      diagnostics: Object.freeze([
        createErrorDiagnostic(
          'plugin_author_evaluation_failed',
          'Plugin author evaluation failed',
          error,
          entry.packageRoot,
        ),
      ]),
    });
  }
  const evaluationMs = Math.max(0, nowMs() - startedAt);
  const slowEvaluationMs = input.slowEvaluationMs ?? 1_000;
  const diagnostics: PluginAuthorDoctorDiagnostic[] = [];
  if (evaluationMs >= slowEvaluationMs) {
    diagnostics.push(Object.freeze({
      code: 'plugin_author_evaluation_slow',
      message: `Plugin author module evaluation took ${evaluationMs}ms (diagnostic threshold ${slowEvaluationMs}ms)`,
    }));
  }
  return Object.freeze({
    ok: true,
    pluginId: evaluated.manifest.id,
    version: evaluated.manifest.version,
    entryPath: evaluated.entry.entryPath,
    evaluationMs,
    canonicalManifestJson: evaluated.canonicalManifestJson,
    diagnostics: Object.freeze(diagnostics),
  });
}
