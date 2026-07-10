import { describe, expect, it } from 'vitest';

import {
  buildRemoteFirstPartyPromotionCommand,
  resolveRemoteFirstPartyInstallLayout,
} from './remoteFirstPartyInstallPath.js';

describe('remote first-party install layout', () => {
  it('builds the canonical versioned install layout for every remote installer strategy', () => {
    expect(resolveRemoteFirstPartyInstallLayout({
      componentId: 'happier-cli',
      channel: 'preview',
      versionId: "preview-1'break-quote",
    })).toEqual({
      remoteHomeDir: '$HOME/.happier',
      installRoot: '$HOME/.happier/cli-preview',
      versionsDir: '$HOME/.happier/cli-preview/versions',
      versionDir: '$HOME/.happier/cli-preview/versions/preview-1-break-quote',
      currentPath: '$HOME/.happier/cli-preview/current',
      previousPath: '$HOME/.happier/cli-preview/previous',
      binaryPath: '$HOME/.happier/cli-preview/current/happier',
    });
  });

  it('builds one shared promote command for uploaded and self-downloaded payloads', () => {
    const layout = resolveRemoteFirstPartyInstallLayout({
      componentId: 'happier-cli',
      channel: 'stable',
      versionId: '1.2.3',
    });

    const command = buildRemoteFirstPartyPromotionCommand({
      layout,
      payloadRootExpression: '"$payload_root"',
    });

    expect(command).toEqual([
      'mkdir -p $HOME/.happier/cli/versions',
      'rm -rf $HOME/.happier/cli/versions/1.2.3',
      'cp -R "$payload_root" $HOME/.happier/cli/versions/1.2.3',
      'chmod +x $HOME/.happier/cli/versions/1.2.3/happier',
      'if [ -L $HOME/.happier/cli/current ]; then prev="$(readlink $HOME/.happier/cli/current || true)"; if [ -n "$prev" ]; then ln -sfn "$prev" $HOME/.happier/cli/previous; fi; fi',
      'ln -sfn $HOME/.happier/cli/versions/1.2.3 $HOME/.happier/cli/current',
    ].join('; '));
  });
});
