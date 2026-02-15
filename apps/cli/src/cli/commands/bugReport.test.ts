import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { __internal, runBugReportCommand, type BugReportCommandDependencies } from './bugReport';

function createDeps(overrides: Partial<BugReportCommandDependencies> = {}): BugReportCommandDependencies {
  return {
    getActiveServerProfile: async () => ({
      id: 'cloud',
      name: 'Happier Cloud',
      serverUrl: 'https://api.happier.dev',
      webappUrl: 'https://app.happier.dev',
    }),
    fetchBugReportsFeature: async () => ({
      enabled: true,
      providerUrl: 'https://reports.happier.dev',
      defaultIncludeDiagnostics: true,
      maxArtifactBytes: 10 * 1024 * 1024,
      acceptedArtifactKinds: ['cli', 'daemon', 'server'],
      uploadTimeoutMs: 20_000,
      contextWindowMs: 30 * 60 * 1_000,
    }),
    collectDiagnosticsArtifacts: async () => ({
      artifacts: [
        {
          filename: 'cli.log',
          sourceKind: 'cli',
          contentType: 'text/plain',
          content: 'tail',
        },
      ],
      environment: {
        appVersion: '1.0.0',
        platform: 'darwin',
        deploymentType: 'cloud',
        serverUrl: 'https://api.happier.dev',
      },
    }),
    submitBugReport: async () => ({
      reportId: 'report-1',
      issueNumber: 123,
      issueUrl: 'https://github.com/happier-dev/happier/issues/123',
    }),
    searchSimilarIssues: async () => ({ issues: [] }),
    isInteractiveTerminal: () => false,
    promptInput: async () => '',
    ...overrides,
  };
}

describe('runBugReportCommand', () => {
  it('fails in non-interactive mode when required fields are missing', async () => {
    const deps = createDeps();
    await expect(runBugReportCommand([], deps)).rejects.toThrow('Non-interactive mode');
  });

  it('includes reporter GitHub username in the submitted summary when provided', async () => {
    const submissions: unknown[] = [];
    const deps = createDeps({
      submitBugReport: async (input) => {
        submissions.push(input);
        return {
          reportId: 'report-gh',
          issueNumber: 11,
          issueUrl: 'https://github.com/happier-dev/happier/issues/11',
        };
      },
    });

    await runBugReportCommand([
      '--title', 'Contact info',
      '--github-username', '@Foo-Bar',
      '--summary', 'The app freezes after login',
      '--current-behavior', 'UI becomes unresponsive for 20 seconds',
      '--expected-behavior', 'UI remains responsive',
      '--repro-step', 'Open app',
      '--no-include-diagnostics',
    ], deps);

    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      form: {
        summary: 'The app freezes after login\n\nReporter GitHub: `Foo-Bar`',
      },
    });
  });

  it('rejects deprecated allow-maintainer-follow-up flags', async () => {
    const deps = createDeps();

    await expect(runBugReportCommand([
      '--title', 'Deprecated flags',
      '--summary', 'summary',
      '--current-behavior', 'current',
      '--expected-behavior', 'expected',
      '--accept-privacy-notice',
      '--allow-maintainer-follow-up',
    ], deps)).rejects.toThrow(/unknown argument/i);
  });

  it('rejects --labels flag as an unknown argument', async () => {
    const deps = createDeps();

    await expect(runBugReportCommand([
      '--title', 'Labels unsupported',
      '--summary', 'summary',
      '--current-behavior', 'current',
      '--expected-behavior', 'expected',
      '--no-include-diagnostics',
      '--labels', 'bug,security',
    ], deps)).rejects.toThrow(/unknown argument/i);
  });

  it('prompts for missing required fields and submits report payload', async () => {
    const prompts = ['Crash when opening app', '', 'yes'];
    const submissions: unknown[] = [];
    const deps = createDeps({
      isInteractiveTerminal: () => true,
      promptInput: async () => prompts.shift() ?? '',
      submitBugReport: async (input) => {
        submissions.push(input);
        return {
          reportId: 'report-2',
          issueNumber: 456,
          issueUrl: 'https://github.com/happier-dev/happier/issues/456',
        };
      },
    });

    const result = await runBugReportCommand([
      '--summary', 'The app freezes after login',
      '--current-behavior', 'UI becomes unresponsive for 20 seconds',
      '--expected-behavior', 'UI remains responsive',
      '--repro-step', 'Open app',
      '--repro-step', 'Login with valid account',
    ], deps);

    expect(result.mode).toBe('submitted');
    if (result.mode !== 'submitted') {
      throw new Error('expected submitted result');
    }
    expect(result.issueNumber).toBe(456);
    expect(result.issueUrl).toBe('https://github.com/happier-dev/happier/issues/456');
    expect(result.diagnosticsIncluded).toBe(true);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      form: {
        title: 'Crash when opening app',
        summary: 'The app freezes after login',
        consent: {
          includeDiagnostics: true,
          acceptedPrivacyNotice: true,
        },
        reproductionSteps: ['Open app', 'Login with valid account'],
      },
    });
  });

  it('respects --no-include-diagnostics and skips diagnostics collection', async () => {
    let collectCalls = 0;
    const submissions: unknown[] = [];
    const deps = createDeps({
      collectDiagnosticsArtifacts: async () => {
        collectCalls += 1;
        return {
          artifacts: [],
          environment: {
            appVersion: '1.0.0',
            platform: 'darwin',
            deploymentType: 'cloud',
            serverUrl: 'https://api.happier.dev',
          },
        };
      },
      submitBugReport: async (input) => {
        submissions.push(input);
        return {
          reportId: 'report-3',
          issueNumber: 789,
          issueUrl: 'https://github.com/happier-dev/happier/issues/789',
        };
      },
    });

    const result = await runBugReportCommand([
      '--title', 'CLI command failure',
      '--summary', 'Command exits with unknown error',
      '--no-include-diagnostics',
    ], deps);

    expect(result.diagnosticsIncluded).toBe(false);
    expect(collectCalls).toBe(0);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      artifacts: [],
      form: {
        consent: {
          includeDiagnostics: false,
        },
      },
    });
    const submittedForm = (submissions[0] as any)?.form ?? {};
    expect('currentBehavior' in submittedForm).toBe(false);
    expect('expectedBehavior' in submittedForm).toBe(false);
    expect('reproductionSteps' in submittedForm).toBe(false);
  });

  it('accepts --existing-issue-number and forwards it to bug report submission', async () => {
    const submissions: unknown[] = [];
    const deps = createDeps({
      submitBugReport: async (input) => {
        submissions.push(input);
        return {
          reportId: 'report-existing',
          issueNumber: 99,
          issueUrl: 'https://github.com/happier-dev/happier/issues/99',
        };
      },
    });

    const result = await runBugReportCommand([
      '--title', 'Duplicate issue',
      '--summary', 'This looks like an existing issue',
      '--current-behavior', 'broken',
      '--expected-behavior', 'works',
      '--repro-step', 'Open app',
      '--no-include-diagnostics',
      '--existing-issue-number', '99',
    ], deps);

    expect(result.mode).toBe('submitted');
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      existingIssueNumber: 99,
    });
  });

  it('prompts to select a similar issue in interactive mode when duplicates are found', async () => {
    const submissions: unknown[] = [];
    const deps = createDeps({
      isInteractiveTerminal: () => true,
      promptInput: async () => '55',
      searchSimilarIssues: async () => ({
        issues: [
          {
            owner: 'happier-dev',
            repo: 'happier',
            number: 55,
            url: 'https://github.com/happier-dev/happier/issues/55',
            title: 'Similar issue',
            state: 'open' as const,
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
      submitBugReport: async (input) => {
        submissions.push(input);
        return {
          reportId: 'report-similar',
          issueNumber: 55,
          issueUrl: 'https://github.com/happier-dev/happier/issues/55',
        };
      },
    });

    await runBugReportCommand([
      '--title', 'Duplicate issue',
      '--summary', 'This looks like an existing issue',
      '--current-behavior', 'broken',
      '--expected-behavior', 'works',
      '--repro-step', 'Open app',
      '--no-include-diagnostics',
    ], deps);

    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      existingIssueNumber: 55,
    });
  });

  it('passes server context window to diagnostics collection', async () => {
    const collectDiagnosticsSpy = vi.fn(async () => ({
      artifacts: [],
      environment: {
        appVersion: '1.0.0',
        platform: 'darwin',
        deploymentType: 'cloud' as const,
        serverUrl: 'https://api.happier.dev',
      },
    }));

    await runBugReportCommand([
      '--title', 'Context window',
      '--summary', 'summary',
      '--current-behavior', 'current behavior',
      '--expected-behavior', 'expected behavior',
      '--repro-step', 'Open app',
      '--accept-privacy-notice',
    ], createDeps({
      fetchBugReportsFeature: async () => ({
        enabled: true,
        providerUrl: 'https://reports.happier.dev',
        defaultIncludeDiagnostics: true,
        maxArtifactBytes: 10 * 1024 * 1024,
        acceptedArtifactKinds: ['cli'],
        uploadTimeoutMs: 20_000,
        contextWindowMs: 45_000,
      }),
      collectDiagnosticsArtifacts: collectDiagnosticsSpy,
    }));

    expect(collectDiagnosticsSpy).toHaveBeenCalledWith(expect.objectContaining({
      contextWindowMs: 45_000,
    }));
  });

  it('collects stack runtime diagnostics artifacts when stack context is active', async () => {
    const collectBugReportMachineDiagnosticsSnapshot = (
      __internal as unknown as {
        collectBugReportMachineDiagnosticsSnapshot?: (input?: {
          daemonLogLimit?: number;
          stackLogLimit?: number;
          stackRuntimeMaxChars?: number;
        }) => Promise<{
          stackContext?: {
            stackName: string | null;
            stackEnvPath: string | null;
            runtimeStatePath: string | null;
            runtimeState: string | null;
            logCandidates: string[];
          } | null;
        }>;
      }
    ).collectBugReportMachineDiagnosticsSnapshot;
    expect(typeof collectBugReportMachineDiagnosticsSnapshot).toBe('function');

    const stackHome = await mkdtemp(join(os.tmpdir(), 'bug-report-stack-diagnostics-'));
    const stackName = 'exp-stack';
    const stackBaseDir = join(stackHome, stackName);
    const stackLogsDir = join(stackBaseDir, 'logs');
    const envPath = join(stackBaseDir, 'env');
    const runtimeStatePath = join(stackBaseDir, 'stack.runtime.json');
    const runnerLogPath = join(stackLogsDir, 'dev.1.log');

    await mkdir(stackLogsDir, { recursive: true });
    await writeFile(envPath, `HAPPIER_STACK_STACK=${stackName}\n`, 'utf8');
    await writeFile(
      runtimeStatePath,
      JSON.stringify(
        {
          stackName,
          logs: {
            runner: runnerLogPath,
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(runnerLogPath, 'stack runner started\n', 'utf8');

    const previousStackName = process.env.HAPPIER_STACK_STACK;
    const previousEnvPath = process.env.HAPPIER_STACK_ENV_FILE;
    const previousRuntimePath = process.env.HAPPIER_STACK_RUNTIME_STATE_PATH;
    process.env.HAPPIER_STACK_STACK = stackName;
    process.env.HAPPIER_STACK_ENV_FILE = envPath;
    process.env.HAPPIER_STACK_RUNTIME_STATE_PATH = runtimeStatePath;

    try {
      const snapshot = await collectBugReportMachineDiagnosticsSnapshot!({
        daemonLogLimit: 3,
        stackLogLimit: 3,
        stackRuntimeMaxChars: 64 * 1024,
      });
      expect(snapshot.stackContext?.stackName).toBe(stackName);
      expect(snapshot.stackContext?.runtimeStatePath).toBe(runtimeStatePath);
      expect(snapshot.stackContext?.logCandidates).toContain(runnerLogPath);
      expect(typeof snapshot.stackContext?.runtimeState).toBe('string');
    } finally {
      if (previousStackName === undefined) {
        delete process.env.HAPPIER_STACK_STACK;
      } else {
        process.env.HAPPIER_STACK_STACK = previousStackName;
      }
      if (previousEnvPath === undefined) {
        delete process.env.HAPPIER_STACK_ENV_FILE;
      } else {
        process.env.HAPPIER_STACK_ENV_FILE = previousEnvPath;
      }
      if (previousRuntimePath === undefined) {
        delete process.env.HAPPIER_STACK_RUNTIME_STATE_PATH;
      } else {
        process.env.HAPPIER_STACK_RUNTIME_STATE_PATH = previousRuntimePath;
      }
    }
  });

  it('keeps raw stack runtime state text when runtime JSON is malformed', async () => {
    const collectBugReportMachineDiagnosticsSnapshot = (
      __internal as unknown as {
        collectBugReportMachineDiagnosticsSnapshot?: (input?: {
          daemonLogLimit?: number;
          stackLogLimit?: number;
          stackRuntimeMaxChars?: number;
        }) => Promise<{
          stackContext?: {
            stackName: string | null;
            stackEnvPath: string | null;
            runtimeStatePath: string | null;
            runtimeState: string | null;
            logCandidates: string[];
          } | null;
        }>;
      }
    ).collectBugReportMachineDiagnosticsSnapshot;
    expect(typeof collectBugReportMachineDiagnosticsSnapshot).toBe('function');

    const stackHome = await mkdtemp(join(os.tmpdir(), 'bug-report-stack-runtime-malformed-'));
    const stackName = 'exp-stack';
    const stackBaseDir = join(stackHome, stackName);
    const stackLogsDir = join(stackBaseDir, 'logs');
    const envPath = join(stackBaseDir, 'env');
    const runtimeStatePath = join(stackBaseDir, 'stack.runtime.json');

    await mkdir(stackLogsDir, { recursive: true });
    await writeFile(envPath, `HAPPIER_STACK_STACK=${stackName}\n`, 'utf8');
    await writeFile(runtimeStatePath, '{"logs":{"runner":"/tmp/runner.log"', 'utf8');

    const previousStackName = process.env.HAPPIER_STACK_STACK;
    const previousEnvPath = process.env.HAPPIER_STACK_ENV_FILE;
    const previousRuntimePath = process.env.HAPPIER_STACK_RUNTIME_STATE_PATH;
    process.env.HAPPIER_STACK_STACK = stackName;
    process.env.HAPPIER_STACK_ENV_FILE = envPath;
    process.env.HAPPIER_STACK_RUNTIME_STATE_PATH = runtimeStatePath;

    try {
      const snapshot = await collectBugReportMachineDiagnosticsSnapshot!({
        daemonLogLimit: 3,
        stackLogLimit: 3,
        stackRuntimeMaxChars: 64 * 1024,
      });
      expect(snapshot.stackContext?.runtimeState).toContain('"logs"');
      expect(snapshot.stackContext?.logCandidates).toEqual([]);
    } finally {
      if (previousStackName === undefined) {
        delete process.env.HAPPIER_STACK_STACK;
      } else {
        process.env.HAPPIER_STACK_STACK = previousStackName;
      }
      if (previousEnvPath === undefined) {
        delete process.env.HAPPIER_STACK_ENV_FILE;
      } else {
        process.env.HAPPIER_STACK_ENV_FILE = previousEnvPath;
      }
      if (previousRuntimePath === undefined) {
        delete process.env.HAPPIER_STACK_RUNTIME_STATE_PATH;
      } else {
        process.env.HAPPIER_STACK_RUNTIME_STATE_PATH = previousRuntimePath;
      }
    }
  });

  it('falls back to GitHub issue flow when server has no provider url', async () => {
    const submitSpy = vi.fn(async () => ({
      reportId: 'report-unexpected',
      issueNumber: 999,
      issueUrl: 'https://github.com/happier-dev/happier/issues/999',
    }));
    const collectDiagnosticsSpy = vi.fn(async () => ({
      artifacts: [],
      environment: {
        appVersion: '1.0.0',
        platform: 'darwin',
        deploymentType: 'cloud' as const,
        serverUrl: 'https://api.happier.dev',
      },
    }));

    const result = await runBugReportCommand([
      '--title', 'No provider configured',
      '--summary', 'summary',
      '--current-behavior', 'current behavior',
      '--expected-behavior', 'expected behavior',
      '--repro-step', 'Open app',
      '--accept-privacy-notice',
    ], createDeps({
      fetchBugReportsFeature: async () => ({
        enabled: true,
        providerUrl: null,
        defaultIncludeDiagnostics: true,
        maxArtifactBytes: 10 * 1024 * 1024,
        acceptedArtifactKinds: ['cli'],
        uploadTimeoutMs: 20_000,
        contextWindowMs: 30 * 60 * 1_000,
      }),
      collectDiagnosticsArtifacts: collectDiagnosticsSpy,
      submitBugReport: submitSpy,
    }));

    expect(result.mode).toBe('fallback');
    if (result.mode !== 'fallback') {
      throw new Error('expected fallback mode');
    }
    expect(result.issueUrl).toContain('github.com/happier-dev/happier/issues/new');
    expect(submitSpy).not.toHaveBeenCalled();
    expect(collectDiagnosticsSpy).not.toHaveBeenCalled();
  });

  it('throws a clear error when --provider-url is invalid', async () => {
    await expect(runBugReportCommand([
      '--title', 'Invalid provider URL',
      '--summary', 'summary',
      '--current-behavior', 'current behavior',
      '--expected-behavior', 'expected behavior',
      '--repro-step', 'Open app',
      '--accept-privacy-notice',
      '--provider-url', 'not-a-valid-url',
    ], createDeps())).rejects.toThrow(/invalid --provider-url/i);
  });

  it('throws a clear error when --provider-url uses a non-http scheme', async () => {
    await expect(runBugReportCommand([
      '--title', 'Invalid provider scheme',
      '--summary', 'summary',
      '--current-behavior', 'current behavior',
      '--expected-behavior', 'expected behavior',
      '--repro-step', 'Open app',
      '--accept-privacy-notice',
      '--provider-url', 'file:///tmp/reports',
    ], createDeps())).rejects.toThrow(/invalid --provider-url/i);
  });

  it('rejects --issue-owner flag as an unknown argument', async () => {
    await expect(runBugReportCommand([
      '--title', 'Invalid owner',
      '--summary', 'summary',
      '--current-behavior', 'current behavior',
      '--expected-behavior', 'expected behavior',
      '--repro-step', 'Open app',
      '--accept-privacy-notice',
      '--issue-owner', '../owner',
    ], createDeps())).rejects.toThrow(/unknown argument/i);
  });

  it('rejects --issue-repo flag as an unknown argument', async () => {
    await expect(runBugReportCommand([
      '--title', 'Invalid repo',
      '--summary', 'summary',
      '--current-behavior', 'current behavior',
      '--expected-behavior', 'expected behavior',
      '--repro-step', 'Open app',
      '--accept-privacy-notice',
      '--issue-repo', 'repo?bad=1',
    ], createDeps())).rejects.toThrow(/unknown argument/i);
  });

  it('prompts to include diagnostics when flag is omitted and skips diagnostics when answered no', async () => {
    let collectCalls = 0;
    const submissions: unknown[] = [];
    const deps = createDeps({
      isInteractiveTerminal: () => true,
      promptInput: async () => 'n',
      collectDiagnosticsArtifacts: async () => {
        collectCalls += 1;
        return {
          artifacts: [],
          environment: {
            appVersion: '1.0.0',
            platform: 'darwin',
            deploymentType: 'cloud',
            serverUrl: 'https://api.happier.dev',
          },
        };
      },
      submitBugReport: async (input) => {
        submissions.push(input);
        return {
          reportId: 'report-no-diags',
          issueNumber: 777,
          issueUrl: 'https://github.com/happier-dev/happier/issues/777',
        };
      },
    });

    const result = await runBugReportCommand([
      '--title', 'No diagnostics',
      '--summary', 'summary',
      '--current-behavior', 'current behavior',
      '--expected-behavior', 'expected behavior',
      '--repro-step', 'Open app',
    ], deps);

    expect(result.mode).toBe('submitted');
    expect(collectCalls).toBe(0);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      artifacts: [],
      form: {
        consent: {
          includeDiagnostics: false,
        },
      },
    });
  });

  it('does not prompt for reproduction steps when none are provided', async () => {
    const prompts = ['n'];
    const submissions: unknown[] = [];
    const deps = createDeps({
      isInteractiveTerminal: () => true,
      promptInput: async () => prompts.shift() ?? '',
      submitBugReport: async (input) => {
        submissions.push(input);
        return {
          reportId: 'report-repro',
          issueNumber: 888,
          issueUrl: 'https://github.com/happier-dev/happier/issues/888',
        };
      },
    });

    await runBugReportCommand([
      '--title', 'Missing repro',
      '--summary', 'summary',
    ], deps);

    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      form: {
        consent: {
          includeDiagnostics: false,
        },
      },
    });
    const submittedForm = (submissions[0] as any)?.form ?? {};
    expect('reproductionSteps' in submittedForm).toBe(false);
  });

  it('reprompts for summary when too short in interactive mode', async () => {
    const prompts = ['Valid summary'];
    const submissions: unknown[] = [];
    const deps = createDeps({
      isInteractiveTerminal: () => true,
      promptInput: async () => prompts.shift() ?? '',
      submitBugReport: async (input) => {
        submissions.push(input);
        return {
          reportId: 'report-summary',
          issueNumber: 333,
          issueUrl: 'https://github.com/happier-dev/happier/issues/333',
        };
      },
    });

    await runBugReportCommand([
      '--title', 'Valid title',
      '--summary', 'x',
      '--no-include-diagnostics',
    ], deps);

    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      form: {
        summary: 'Valid summary',
      },
    });
  });

});
