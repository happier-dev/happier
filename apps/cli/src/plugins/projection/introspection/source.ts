import type { PluginDiagnosticRecordV1 } from '@happier-dev/protocol';

export function mapPluginSourceToDiagnosticSource(
  source: Readonly<{ kind: string; devWatch?: boolean }>,
): PluginDiagnosticRecordV1['plugin']['source'] {
  if (source.kind === 'bundled') return 'bundled';
  if (source.kind === 'archive') return 'archive';
  if (source.kind === 'package' || source.kind === 'marketplace') return 'npm';
  return source.devWatch === true ? 'development' : 'localPath';
}
