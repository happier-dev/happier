import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const PROJECT_COMPUTE_ENV_MAX_ENTRIES = 64;
export const PROJECT_COMPUTE_ENV_MAX_KEY_LENGTH = 128;
export const PROJECT_COMPUTE_ENV_MAX_VALUE_LENGTH = 8_192;

export const PROJECT_COMPUTE_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const PROTOTYPE_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Exact environment variable names that cannot be overridden via ad-hoc
 * `projects.compute.exec` literal `env` input (checked case-insensitively for
 * POSIX and Windows safety).
 */
export const PROJECT_COMPUTE_BLOCKED_ENV_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'PATHEXT',
  'COMSPEC',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_PATH',
  'BASH_ENV',
  'ENV',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'RUBYOPT',
  'RUBYLIB',
  'PERL5OPT',
  'PERL5LIB',
  'IFS',
  'ZDOTDIR',
  'PROMPT_COMMAND',
  'CDPATH',
  'GLOBIGNORE',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'SSH_ASKPASS',
  'SUDO_ASKPASS',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
]);

/**
 * Case-insensitive environment variable prefixes that cannot be overridden via
 * ad-hoc `projects.compute.exec` literal `env` input.
 */
export const PROJECT_COMPUTE_BLOCKED_ENV_KEY_PREFIXES: readonly string[] = Object.freeze([
  'LD_',
  'DYLD_',
  'HAPPIER_',
  'BASH_FUNC_',
  'GIT_CONFIG_KEY_',
  'GIT_CONFIG_VALUE_',
]);

/** Returns true when `key` is blocked by the compute-exec security policy. */
export function isBlockedProjectComputeEnvKey(key: string): boolean {
  if (PROTOTYPE_POLLUTION_KEYS.has(key.toLowerCase())) return true;
  const upper = key.toUpperCase();
  if (PROJECT_COMPUTE_BLOCKED_ENV_KEYS.has(upper)) return true;
  return PROJECT_COMPUTE_BLOCKED_ENV_KEY_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Canonical validator for a single `projects.compute.exec` environment variable
 * name: valid POSIX identifier, bounded length, not prototype-polluting, and not
 * in the loader/shell/git/proxy/Happier blocklist.
 */
export function isValidProjectComputeEnvKey(key: string): boolean {
  if (typeof key !== 'string') return false;
  if (key.length === 0 || key.length > PROJECT_COMPUTE_ENV_MAX_KEY_LENGTH) return false;
  if (!PROJECT_COMPUTE_ENV_KEY_PATTERN.test(key)) return false;
  if (isBlockedProjectComputeEnvKey(key)) return false;
  return true;
}

export type ProjectComputeEnvValidationResultV1 =
  | Readonly<{ ok: true; value: Readonly<Record<string, string>> }>
  | Readonly<{ ok: false; reason: string; key?: string }>;

/**
 * Canonical validator for `projects.compute.exec` literal `env` overrides.
 * Shared across protocol schema admission and daemon execution so there is one
 * single security owner.
 */
export function validateProjectComputeEnv(
  raw: unknown,
): ProjectComputeEnvValidationResultV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'Environment overrides must be an object mapping variable names to literal strings.' };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > PROJECT_COMPUTE_ENV_MAX_ENTRIES) {
    return {
      ok: false,
      reason: `Environment overrides may contain at most ${PROJECT_COMPUTE_ENV_MAX_ENTRIES} entries.`,
    };
  }
  const validated: Record<string, string> = Object.create(null);
  for (const [key, value] of entries) {
    if (!isValidProjectComputeEnvKey(key)) {
      return {
        ok: false,
        key,
        reason: isBlockedProjectComputeEnvKey(key)
          ? `Environment variable ${JSON.stringify(key)} cannot be overridden.`
          : `Invalid environment variable name ${JSON.stringify(key)}.`,
      };
    }
    if (typeof value !== 'string') {
      return {
        ok: false,
        key,
        reason: `Environment variable ${JSON.stringify(key)} must have a string value.`,
      };
    }
    if (value.includes('\0')) {
      return {
        ok: false,
        key,
        reason: `Environment variable ${JSON.stringify(key)} value cannot contain NUL bytes.`,
      };
    }
    if (value.length > PROJECT_COMPUTE_ENV_MAX_VALUE_LENGTH) {
      return {
        ok: false,
        key,
        reason: `Environment variable ${JSON.stringify(key)} value exceeds ${PROJECT_COMPUTE_ENV_MAX_VALUE_LENGTH} characters.`,
      };
    }
    validated[key] = value;
  }
  return { ok: true, value: Object.assign({}, validated) };
}

const ProjectComputeExecEnvKeyV1Schema = lazyZodSchema(() =>
  z.string().check(
    z.minLength(1),
    z.maxLength(PROJECT_COMPUTE_ENV_MAX_KEY_LENGTH),
    z.refine((key) => isValidProjectComputeEnvKey(key), {
      message: 'Environment variable name is invalid or blocked.',
    }),
  ),
);

const ProjectComputeExecEnvValueV1Schema = lazyZodSchema(() =>
  z.string().check(
    z.maxLength(PROJECT_COMPUTE_ENV_MAX_VALUE_LENGTH),
    z.refine((value) => !value.includes('\0'), {
      message: 'Environment variable value cannot contain NUL bytes.',
    }),
  ),
);

const ProjectComputeExecEnvRecordV1Schema = lazyZodSchema(() =>
  z.record(ProjectComputeExecEnvKeyV1Schema, ProjectComputeExecEnvValueV1Schema).check(
    z.superRefine((record, context) => {
      const entries = Object.entries(record);
      if (entries.length > PROJECT_COMPUTE_ENV_MAX_ENTRIES) {
        context.addIssue({
          code: 'custom',
          path: [],
          message: `Environment overrides may contain at most ${PROJECT_COMPUTE_ENV_MAX_ENTRIES} entries.`,
        });
      }
    }),
  ),
);

/**
 * Canonical Zod schema for `projects.compute.exec` literal non-secret `env`
 * overrides. Enforces bounded entry count, valid identifier names, blocked-key
 * policy, prototype-pollution protection (including own `__proto__` keys that
 * `z.record` otherwise skips), NUL-byte rejection, and value length bounds.
 */
export const ProjectComputeExecEnvV1Schema = lazyZodSchema(() =>
  z.pipe(
    z.transform((value: Record<string, string>, context) => {
      if (value && typeof value === 'object' && !Array.isArray(value)
        && Object.prototype.hasOwnProperty.call(value, '__proto__')) {
        context.issues.push({
          code: 'custom',
          input: value,
          path: ['__proto__'],
          message: 'Environment variable "__proto__" cannot be overridden.',
        });
        return z.NEVER;
      }
      return value;
    }),
    ProjectComputeExecEnvRecordV1Schema,
  ),
);

export type ProjectComputeExecEnvV1 = z.infer<typeof ProjectComputeExecEnvV1Schema>;
