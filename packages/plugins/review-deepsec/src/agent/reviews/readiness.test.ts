import { describe, expect, it } from 'vitest';

import { checkDeepSecReadiness } from './readiness.js';

describe('checkDeepSecReadiness', () => {
  it('classifies the DeepSec tool runtime as unknown when the host has no runtime diagnostic', () => {
    expect(checkDeepSecReadiness({
      executablePath: '/tools/deepsec',
      agentCli: 'claude',
      hasGatewayKey: true,
    })).toEqual({
      status: 'ready',
      executablePath: '/tools/deepsec',
      agentCli: 'claude',
      toolRuntime: {
        kind: 'unknown',
        diagnostics: [],
      },
    });
  });

  it('reports missing prerequisites as structured remediation', () => {
    expect(checkDeepSecReadiness({
      executablePath: null,
      toolRuntime: {
        kind: 'node',
        version: '20.19.0',
        majorVersion: 20,
        diagnostics: [],
      },
      agentCli: null,
      hasGatewayKey: false,
    })).toEqual({
      status: 'missing',
      missing: ['deepsec', 'node>=22', 'claude-or-codex', 'AI_GATEWAY_API_KEY'],
      toolRuntime: {
        kind: 'node',
        version: '20.19.0',
        majorVersion: 20,
        diagnostics: [],
      },
      installUrl: 'https://github.com/vercel-labs/deepsec',
      commandPreview: ['deepsec', '--help'],
      messageKey: 'plugins.deepsec.readiness.missing',
    });
  });
});
