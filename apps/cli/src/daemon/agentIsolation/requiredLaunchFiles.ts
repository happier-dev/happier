import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import type { AgentLaunchSelectedMaterial } from './agentLaunchFrame';

/** Select only declared launch dependencies. The native shim remains their sole
 * publisher; the plugin still owns disposal of its host-side generated files. */
export async function selectRequiredAgentLaunchFiles(input: Readonly<{
  runtimeHome: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  nativeEnvironment?: Readonly<Record<string, string>>;
  selectedMaterials: readonly AgentLaunchSelectedMaterial[];
  requiredFiles?: readonly string[];
  signal: AbortSignal;
}>): Promise<Readonly<{
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  selectedMaterials: readonly AgentLaunchSelectedMaterial[];
  requiredFiles: readonly string[];
}>> {
  const selected = new Map(input.selectedMaterials.map(file => [join(input.runtimeHome, file.relativePath), file]));
  // Consume the materializer's admitted native roots, never infer a new home.
  const roots = Object.entries(input.nativeEnvironment ?? {}).flatMap(([key, target]) => {
    const source = input.environment[key];
    return source && isAbsolute(source) && isAbsolute(target) && source !== target
      && isCanonicalAbsolutePathInsideRoot(input.runtimeHome, target) ? [{ source, target }] : [];
  }).sort((a, b) => b.source.length - a.source.length);
  const generatedRoots = new Map<string, string>();
  const paths = new Map<string, string>();
  for (const source of new Set(input.requiredFiles)) {
    input.signal.throwIfAborted();
    // An already-native path must be supplied by its incumbent materializer.
    // Do not read a member's native home back through the daemon identity.
    if (selected.has(source) || !isAbsolute(source) || isCanonicalAbsolutePathInsideRoot(input.runtimeHome, source)) {
      paths.set(source, source);
      continue;
    }
    const root = roots.find(root => isCanonicalAbsolutePathInsideRoot(root.source, source));
    let target: string;
    if (root) target = join(root.target, relative(root.source, source));
    else if (!input.args.includes(source) && !Object.values(input.environment).includes(source)) {
      // A directory-based dependency requires the incumbent native-root
      // projection; copying its leaf alone cannot establish native discovery.
      paths.set(source, source);
      continue;
    } else {
      const parent = dirname(source);
      let targetParent = generatedRoots.get(parent);
      if (!targetParent) {
        targetParent = join(input.runtimeHome, 'files', 'required', String(generatedRoots.size));
        generatedRoots.set(parent, targetParent);
      }
      target = join(targetParent, basename(source));
    }
    paths.set(source, target);
    if (selected.has(target)) continue;
    let bytes: Buffer;
    try { bytes = await readFile(source, { signal: input.signal }); }
    catch (error) {
      input.signal.throwIfAborted();
      const causeCode = (error as NodeJS.ErrnoException).code;
      throw new PluginError({ code: 'agent_launch_required_file_unavailable',
        message: 'Required Agent extension or configuration could not be selected for the native launch', retryable: false,
        failureCause: projectActionFailureCauseV1(error),
        details: { phase: 'materialization', reason: 'unreadable',
          ...(causeCode ? { causeCode } : {}) } });
    }
    selected.set(target, { relativePath: relative(input.runtimeHome, target).split('\\').join('/'), contentBase64: bytes.toString('base64') });
  }
  const rewrites = [...roots, ...[...generatedRoots].map(([source, target]) => ({ source, target }))]
    .sort((a, b) => b.source.length - a.source.length);
  const rewritePath = (value: string): string => {
    const exact = paths.get(value);
    if (exact) return exact;
    if (!isAbsolute(value)) return value;
    const root = rewrites.find(root => isCanonicalAbsolutePathInsideRoot(root.source, value));
    return root ? join(root.target, relative(root.source, value)) : value;
  };
  const rewriteJson = (value: unknown): unknown => {
    if (typeof value === 'string') return rewritePath(value);
    if (Array.isArray(value)) return value.map(rewriteJson);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, rewriteJson(value)]));
    return value;
  };
  const rewriteValue = (value: string): string => {
    // Native configs may reference a generated plugin directory in JSON env.
    if (/^\s*[\[{]/u.test(value)) {
      try { return JSON.stringify(rewriteJson(JSON.parse(value))); } catch { /* An opaque non-JSON value is preserved. */ }
    }
    return rewritePath(value);
  };
  return { args: input.args.map(rewriteValue),
    environment: Object.fromEntries(Object.entries({ ...input.environment, ...input.nativeEnvironment })
      .map(([key, value]) => [key, rewriteValue(value)])),
    selectedMaterials: [...selected.values()], requiredFiles: [...paths.values()] };
}
