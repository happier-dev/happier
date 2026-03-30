import type { PreflightModelsProbeAdapter } from '@/capabilities/probes/preflightModelsProbeAdapterTypes';
import { resolveProviderCliCommand } from '@/runtime/managedTools/providerCliResolution';
import { resolveCliPathOverride } from '@/agent/acp/resolveCliPathOverride';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { killProcessTree } from '@/agent/acp/killProcessTree';
import { spawn } from 'node:child_process';

type PiProbedModelRow = Readonly<{
  id: string;
  name: string;
  description?: string;
  supportsThinking?: boolean;
}>;

function parsePiListModelsOutput(textRaw: string): PiProbedModelRow[] | null {
  const text = typeof textRaw === 'string' ? textRaw : '';
  if (!text.trim()) return null;

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const parsed: PiProbedModelRow[] = [];
  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized) continue;

    // Skip the tabular header if present.
    if (normalized.toLowerCase().startsWith('provider') && normalized.toLowerCase().includes('model')) {
      continue;
    }

    // Expected table format (as of pi-coding-agent 0.62.x):
    // provider <ws> model <ws> context <ws> max-out <ws> thinking <ws> images
    // We parse the first two columns, then best-effort extract the "thinking" column.
    const parts = normalized.split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;

    const provider = String(parts[0] ?? '').trim();
    const model = String(parts[1] ?? '').trim();
    if (!provider || !model) continue;

    const thinkingRaw = typeof parts[4] === 'string' ? parts[4].trim().toLowerCase() : '';
    const supportsThinking =
      thinkingRaw === 'yes' ? true
      : thinkingRaw === 'no' ? false
      : undefined;

    parsed.push({
      id: `${provider}/${model}`,
      name: model,
      description: provider,
      ...(typeof supportsThinking === 'boolean' ? { supportsThinking } : {}),
    });
  }

  return parsed.length > 0 ? parsed : null;
}

async function probePiListModels(params: Readonly<{ cwd: string; timeoutMs: number }>): Promise<PiProbedModelRow[] | null> {
  const timeoutMs = Math.max(250, params.timeoutMs);
  const command =
    resolveProviderCliCommand('pi')?.command
    ?? resolveCliPathOverride({ agentId: 'pi' })
    ?? 'pi';
  const args = ['--list-models'];

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: PiProbedModelRow[] | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const invocation = resolveWindowsCommandInvocation({
      command,
      args,
      resolveCommandOnPath: true,
    });

    const child = spawn(invocation.command, invocation.args, {
      cwd: params.cwd,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    const timer = setTimeout(() => {
      if (process.platform === 'win32') {
        void killProcessTree(child, { graceMs: 250 }).catch(() => undefined);
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
      finish(null);
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      if (typeof code !== 'number' || code !== 0) return finish(null);

      // Prefer parsing stdout, but fall back to stderr: Pi prints `--list-models` to stderr.
      const models = parsePiListModelsOutput(stdout) ?? parsePiListModelsOutput(stderr);
      finish(models);
    });
  });
}

export const piPreflightModelsProbeAdapter: PreflightModelsProbeAdapter = {
  failureCacheStrategy: 'cooldown',
  probeModelsRaw: async ({ cwd, timeoutMs }) => {
    const models = await probePiListModels({ cwd, timeoutMs });
    if (!models) return null;
    return models.map((m) => ({
      id: m.id,
      name: m.name,
      ...(typeof m.description === 'string' ? { description: m.description } : {}),
      ...(m.supportsThinking === true ? {
        modelOptions: [{
          id: 'reasoning_effort',
          name: 'Thinking',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
            { value: 'xhigh', name: 'Max' },
          ],
        }],
      } : {}),
    }));
  },
};
