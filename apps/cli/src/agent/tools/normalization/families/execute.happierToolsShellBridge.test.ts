import { describe, expect, it } from 'vitest';

import { normalizeBashInput } from './execute';
import { extractCanonicalInputFromHappierToolsShellBridge } from '../happierToolsShellBridgeCanonicalization';

describe('normalizeBashInput (Happier tools shell bridge)', () => {
  it('attaches parsed Happier tools shell-bridge metadata for node-invoked happier tools call commands', () => {
    const normalized = normalizeBashInput({
      command: [
        '/bin/zsh',
        '-lc',
        `'${process.execPath}' '--no-warnings' '--no-deprecation' '/Users/leeroy/Documents/Development/happier/dev/apps/cli/dist/index.mjs' 'tools' 'call' '--source' 'happier' '--tool' 'change_title' '--args-json' '{"title":"Renamed"}' '--json'`,
      ],
    });

    expect(normalized.command).toBe(
      `'${process.execPath}' '--no-warnings' '--no-deprecation' '/Users/leeroy/Documents/Development/happier/dev/apps/cli/dist/index.mjs' 'tools' 'call' '--source' 'happier' '--tool' 'change_title' '--args-json' '{"title":"Renamed"}' '--json'`,
    );
    expect(normalized.happierToolsShellBridge).toEqual({
      kind: 'call',
      rawCommand:
        `'${process.execPath}' '--no-warnings' '--no-deprecation' '/Users/leeroy/Documents/Development/happier/dev/apps/cli/dist/index.mjs' 'tools' 'call' '--source' 'happier' '--tool' 'change_title' '--args-json' '{"title":"Renamed"}' '--json'`,
      sessionId: null,
      directory: null,
      source: 'happier',
      tool: 'change_title',
      argsJson: '{"title":"Renamed"}',
      args: { title: 'Renamed' },
      json: true,
    });
  });

  it('canonicalizes shell-bridge inputs that use cmd instead of command', () => {
    const canonical = extractCanonicalInputFromHappierToolsShellBridge({
      cmd: `'${process.execPath}' '--no-warnings' '--no-deprecation' '/Users/leeroy/Documents/Development/happier/dev/apps/cli/dist/index.mjs' 'tools' 'call' '--source' 'happier' '--tool' 'change_title' '--args-json' '{"title":"Renamed"}' '--json'`,
    });

    expect(canonical).toEqual({
      title: 'Renamed',
      happierToolsShellBridge: {
        kind: 'call',
        rawCommand:
          `'${process.execPath}' '--no-warnings' '--no-deprecation' '/Users/leeroy/Documents/Development/happier/dev/apps/cli/dist/index.mjs' 'tools' 'call' '--source' 'happier' '--tool' 'change_title' '--args-json' '{"title":"Renamed"}' '--json'`,
        sessionId: null,
        directory: null,
        source: 'happier',
        tool: 'change_title',
        argsJson: '{"title":"Renamed"}',
        args: { title: 'Renamed' },
        json: true,
      },
    });
  });
});
