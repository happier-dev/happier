import type { RegistrySourceDescriptorV1 } from './registrySourcesV1.js';
import type { RegistryFormatAdapterV1 } from './formats/registryFormatAdapterV1.js';

/** D13/R4's single placement decision; the host only executes this ordered plan. */
export function resolveRegistryFetchPlanV1(input: Readonly<{ host: 'web' | 'native' | 'node';
  adapter: RegistryFormatAdapterV1; source: RegistrySourceDescriptorV1; op?: 'list' | 'read' | 'files' }>): readonly ('direct' | 'daemon')[] {
  if (input.host === 'node') return ['direct'];
  if ('packageContent' in input.source) return ['daemon'];
  if (input.source.token) return ['daemon'];
  // IR-99: platform HTTP cannot read non-GitHub repositories, including
  // retained 0.2 SSH/git/local sources. Their SCM reader lives on the daemon.
  if (input.source.format === 'git' && !input.adapter.browserFetchable(input.source)) return ['daemon'];
  if (input.host === 'native') return ['direct'];
  const browserFetchable = input.adapter.browserFetchable(input.source)
    || input.source.format === 'skills-sh' && input.op !== undefined && input.op !== 'list';
  if (!browserFetchable) return ['daemon'];
  return input.source.origin.kind === 'user' ? ['direct', 'daemon'] : ['direct'];
}
