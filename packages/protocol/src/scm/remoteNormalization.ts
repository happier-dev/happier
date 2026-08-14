import { z } from 'zod';

export type ScmRemoteRequestNormalizationResult =
  | { ok: true; request: { remote: string | undefined; branch: string | undefined } }
  | { ok: false; error: string };

export type ScmRemoteNameNormalizationResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

export type ScmRemoteUrlNormalizationResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export type ScmBranchSourceRefNormalizationResult =
  | { ok: true; sourceRef: string }
  | { ok: false; error: string };

const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F]/;

function hasUnsupportedRemoteRefSyntax(
  value: string,
  label: 'Remote name' | 'Branch name',
  options?: { allowRemoteNameSlash?: boolean }
): boolean {
  if (CONTROL_CHAR_REGEX.test(value)) return true;
  if (value.includes('\\')) return true;
  if (value.includes('//')) return true;
  if (value.startsWith('/') || value.endsWith('/')) return true;
  if (value.includes('@{') || value.includes('..')) return true;

  if (label === 'Remote name') {
    return value.includes(':') || (!options?.allowRemoteNameSlash && value.includes('/'));
  }

  return (
    value.startsWith('+') ||
    value.startsWith('.') ||
    value.endsWith('.') ||
    value.endsWith('.lock') ||
    value.includes(':') ||
    value.includes('^') ||
    value.includes('~') ||
    value.includes('?') ||
    value.includes('*') ||
    value.includes('[')
  );
}

function normalizeRemoteRefValue(
  value: string | undefined,
  label: 'Remote name' | 'Branch name',
  options?: { allowRemoteNameSlash?: boolean }
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  const normalized = value.trim();
  if (!normalized) {
    return { ok: true, value: undefined };
  }
  if (normalized.startsWith('-')) {
    return { ok: false, error: `${label} cannot start with "-"` };
  }
  if (/\s/.test(normalized)) {
    return { ok: false, error: `${label} must not contain whitespace` };
  }
  if (normalized.includes('\0')) {
    return { ok: false, error: `${label} contains unsupported characters` };
  }
  if (hasUnsupportedRemoteRefSyntax(normalized, label, options)) {
    return { ok: false, error: `${label} contains unsupported syntax` };
  }
  return { ok: true, value: normalized };
}

function normalizeRequiredRemoteRefValue(
  value: string | undefined,
  label: 'Remote name' | 'Branch name'
): { ok: true; value: string } | { ok: false; error: string } {
  const normalized = normalizeRemoteRefValue(value, label);
  if (!normalized.ok) {
    return normalized;
  }
  if (!normalized.value) {
    return { ok: false, error: `${label} is required` };
  }
  return { ok: true, value: normalized.value };
}

export function normalizeScmRemoteName(
  value: string | undefined,
  options: { allowSlash?: boolean } = {}
): ScmRemoteNameNormalizationResult {
  const normalized = normalizeRemoteRefValue(value, 'Remote name', {
    allowRemoteNameSlash: options.allowSlash ?? true,
  });
  if (!normalized.ok) {
    return normalized;
  }
  if (!normalized.value) {
    return { ok: false, error: 'Remote name is required' };
  }
  return { ok: true, name: normalized.value };
}

export function normalizeScmRemoteUrl(
  value: string | undefined,
  label = 'Remote URL'
): ScmRemoteUrlNormalizationResult {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return { ok: false, error: `${label} is required` };
  }
  if (normalized.startsWith('-')) {
    return { ok: false, error: `${label} cannot start with "-"` };
  }
  if (CONTROL_CHAR_REGEX.test(normalized)) {
    return { ok: false, error: `${label} contains unsupported characters` };
  }
  return { ok: true, url: normalized };
}

export function normalizeScmBranchSourceRef(
  value: string | undefined
): ScmBranchSourceRefNormalizationResult {
  const normalized = normalizeRequiredRemoteRefValue(value, 'Branch name');
  if (!normalized.ok) {
    return { ok: false, error: normalized.error.replace(/^Branch name/, 'Source ref') };
  }
  return { ok: true, sourceRef: normalized.value };
}

function createNormalizedStringSchema<TValue extends string>(
  normalize: (value: string | undefined) => { ok: true; value: TValue } | { ok: false; error: string }
) {
  return z.string().transform((value, ctx) => {
    const result = normalize(value);
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: result.error,
      });
      return z.NEVER;
    }
    return result.value;
  });
}

export const ScmRemoteNameSchema = createNormalizedStringSchema((value) => {
  const normalized = normalizeScmRemoteName(value);
  return normalized.ok
    ? { ok: true, value: normalized.name }
    : normalized;
});
export type ScmRemoteName = z.infer<typeof ScmRemoteNameSchema>;

export const ScmOptionalRemoteNameSchema = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }
  return value.trim() ? value : undefined;
}, ScmRemoteNameSchema.optional());
export type ScmOptionalRemoteName = z.infer<typeof ScmOptionalRemoteNameSchema>;

export const ScmRemoteManagementNameSchema = createNormalizedStringSchema((value) => {
  const normalized = normalizeScmRemoteName(value, { allowSlash: false });
  return normalized.ok
    ? { ok: true, value: normalized.name }
    : normalized;
});
export const ScmOptionalRemoteManagementNameSchema = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }
  return value.trim() ? value : undefined;
}, ScmRemoteManagementNameSchema.optional());

export const ScmRemoteUrlSchema = createNormalizedStringSchema((value) => {
  const normalized = normalizeScmRemoteUrl(value);
  return normalized.ok
    ? { ok: true, value: normalized.url }
    : normalized;
});
export type ScmRemoteUrl = z.infer<typeof ScmRemoteUrlSchema>;

export const ScmBranchSourceRefSchema = createNormalizedStringSchema((value) => {
  const normalized = normalizeScmBranchSourceRef(value);
  return normalized.ok
    ? { ok: true, value: normalized.sourceRef }
    : normalized;
});
export type ScmBranchSourceRef = z.infer<typeof ScmBranchSourceRefSchema>;

export const ScmOptionalBranchSourceRefSchema = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }
  return value.trim() ? value : undefined;
}, ScmBranchSourceRefSchema.optional());
export type ScmOptionalBranchSourceRef = z.infer<typeof ScmOptionalBranchSourceRefSchema>;

export function normalizeScmRemoteRequest(
  request: Readonly<{ remote?: string; branch?: string }>
): ScmRemoteRequestNormalizationResult {
  const remote = normalizeRemoteRefValue(request.remote, 'Remote name', {
    allowRemoteNameSlash: true,
  });
  if (!remote.ok) {
    return remote;
  }
  const branch = normalizeRemoteRefValue(request.branch, 'Branch name');
  if (!branch.ok) {
    return branch;
  }
  return {
    ok: true,
    request: {
      remote: remote.value,
      branch: branch.value,
    },
  };
}
