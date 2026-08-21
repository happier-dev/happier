import {
  collectCurrentMachineReachableServerUrlCandidates,
  type CurrentMachineReachableServerUrlCandidate,
  type CurrentMachineReachableServerUrlCandidateDeps,
} from './currentMachineReachableServerUrlCandidates';
import { promptInput } from '@/terminal/prompts/promptInput';

type PromptDeps = CurrentMachineReachableServerUrlCandidateDeps & Readonly<{
  promptInput?: (prompt: string) => Promise<string>;
}>;

function parseSelectedIndex(answer: string): number | null {
  if (!/^\d+$/.test(answer)) return null;
  const parsed = Number(answer);
  return Number.isInteger(parsed) && parsed > 0 ? parsed - 1 : null;
}

function looksLikeUrl(answer: string): boolean {
  return /^https?:\/\//i.test(answer);
}

export async function promptForCurrentMachineReachableServerUrl(
  params: Readonly<{
    localServerUrl: string;
    remoteDescription?: string;
    /**
     * Overrides the line that introduces `localServerUrl`. The default says the
     * relay is only reachable from this computer, which is true when a caller
     * has just discovered a loopback URL but not when it is asking about a URL
     * that is already reachable elsewhere.
     */
    localServerUrlIntro?: string;
    /**
     * Already-collected candidates. Callers that had to look at the candidates
     * before deciding to prompt pass them back rather than paying for a second
     * round of Tailscale lookups and TCP probes.
     */
    candidates?: readonly CurrentMachineReachableServerUrlCandidate[];
  }>,
  deps: PromptDeps = {},
): Promise<string> {
  const input = deps.promptInput ?? promptInput;
  const remoteDescription = String(params.remoteDescription ?? 'the remote machine').trim() || 'the remote machine';
  const intro = String(params.localServerUrlIntro ?? '').trim()
    || 'The selected relay is only reachable from this computer:';
  const candidates = params.candidates
    ?? await collectCurrentMachineReachableServerUrlCandidates(params, deps);

  if (candidates.length === 0) {
    return (await input([
      intro,
      `  ${params.localServerUrl}`,
      '',
      `Enter an address ${remoteDescription} can use to reach this computer's relay: `,
    ].join('\n'))).trim();
  }

  const lines = [
    intro,
    `  ${params.localServerUrl}`,
    '',
    `Choose the address ${remoteDescription} should use to reach this computer's relay:`,
    '',
    ...candidates.map((candidate, index) => `  ${index + 1}) ${candidate.label}  ${candidate.url}`),
    `  ${candidates.length + 1}) Custom`,
    '',
  ];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = (await input(`${lines.join('\n')}Enter a number (1-${candidates.length + 1}) or URL: `)).trim();
    if (!answer) continue;
    const index = parseSelectedIndex(answer);
    if (index !== null) {
      if (index >= 0 && index < candidates.length) return candidates[index].url;
      if (index === candidates.length) {
        return (await input(`Enter an address ${remoteDescription} can use to reach this computer's relay: `)).trim();
      }
    }
    if (answer.toLowerCase() === 'c' || answer.toLowerCase() === 'custom') {
      return (await input(`Enter an address ${remoteDescription} can use to reach this computer's relay: `)).trim();
    }
    if (looksLikeUrl(answer)) return answer;
  }

  return (await input(`Enter an address ${remoteDescription} can use to reach this computer's relay: `)).trim();
}
