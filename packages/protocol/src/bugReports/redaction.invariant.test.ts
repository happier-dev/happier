import { describe, expect, it } from 'vitest';

import { redactBackgroundCommand } from '../activity/backgroundTask/backgroundTaskRedaction.js';
import { redactBugReportSensitiveText } from './redaction.js';

/**
 * # The invariant, as a generated property rather than a table of shapes
 *
 * **When the scrubber emits `[REDACTED]`, no part of the credential it matched survives on the same
 * line.**
 *
 * A marker beside a live credential is worse than no marker: it defeats grep, it defeats audit, and
 * it makes every marker-presence gate pass on a leak. Three separate leaks in this corridor were the
 * same defect (a value class that stopped at a quote, a value class that stopped at a space), and
 * each per-shape regex patch produced the next instance — so the gate is a *composition generator*,
 * not another list of inputs. Every credential introducer is crossed with every secret body and
 * every trailing context; a new rule that terminates a value badly fails here without anyone having
 * thought of its shape first.
 *
 * The needles are what the assertion looks for: distinctive high-entropy runs placed on both sides
 * of the separators (quotes, spaces, newlines, base64 punctuation) that a value class can be fooled
 * by. Marker presence is never a pass condition.
 */

/** First eight characters of each needle: survives label truncation, still unmistakable. */
const NEEDLE_TRACES = ['zVq7Ky3T', 'Qm4Rt8Lp', 'Hd5Wc1Bz'] as const;
const [FIRST, SECOND, THIRD] = ['zVq7Ky3TmXw9', 'Qm4Rt8Lp2Ns6', 'Hd5Wc1Bz7Yx3'] as const;

const SECRET_BODIES: ReadonlyArray<readonly [string, string]> = [
  ['plain', FIRST],
  ['long', `${FIRST}${SECOND}`],
  ['base64-punctuation', `${FIRST}/${SECOND}+${THIRD}=`],
  ['embedded-double-quote', `${FIRST}"${SECOND}`],
  ['embedded-single-quote', `${FIRST}'${SECOND}`],
  ['embedded-space', `${FIRST} ${SECOND}`],
  ['embedded-newline', `${FIRST}\n${SECOND}`],
  ['separators', `${FIRST}-${SECOND}.${THIRD}`],
  ['named-anthropic', `sk-ant-api03-${FIRST}${SECOND}`],
  ['named-github', `ghp_${FIRST}${SECOND}${THIRD}`],
];

/**
 * Each introducer places the secret where a real log line, shell command or dump would put it.
 *
 * `quoted` records whether the credential sits inside quotes *in the composed text*. It is a
 * well-formedness flag, not a convenience: a credential containing whitespace is only one value
 * when something quotes it. Composing `--password A B` and then demanding that `B` be redacted
 * would demand that the scrubber treat every following shell word as credential material, which
 * would blank the rest of every command line it ever sees.
 */
const INTRODUCERS: ReadonlyArray<readonly [string, (secret: string) => string, boolean]> = [
  ['header-bare', (s) => `Authorization: ${s}`, false],
  ['header-bearer', (s) => `Authorization: Bearer ${s}`, false],
  ['header-no-space', (s) => `authorization:${s}`, false],
  ['header-loose-spacing', (s) => `AUTHORIZATION  :  Bearer ${s}`, false],
  ['header-double-quoted', (s) => `Authorization: "${s}"`, true],
  ['header-single-quoted', (s) => `Authorization: '${s}'`, true],
  ['header-quote-after-scheme', (s) => `Authorization: Bearer "${s}"`, true],
  ['header-in-curl-argument', (s) => `curl -H "Authorization: Bearer ${s}" https://x.test`, true],
  ['header-in-single-quoted-argument', (s) => `curl -H 'authorization: bearer ${s}' --verbose`, true],
  ['header-powershell', (s) => `Invoke-WebRequest -Headers @{Authorization="Bearer ${s}"}`, true],
  ['header-json', (s) => `{"Authorization":"Bearer ${s}"}`, true],
  ['header-folded', (s) => `authorization:\n  Bearer ${s}`, false],
  ['assignment-folded', (s) => `password:\n\t${s}`, false],
  ['header-cookie', (s) => `cookie: ${s}`, false],
  ['header-x-api-key', (s) => `x-api-key: ${s}`, false],
  ['flag-bare', (s) => `deploy --password ${s}`, false],
  ['flag-double-quoted', (s) => `deploy --password "${s}"`, true],
  ['flag-single-quoted', (s) => `deploy --token '${s}'`, true],
  ['flag-with-trailing-flag', (s) => `deploy --api-key ${s} --verbose`, false],
  ['assignment-spaced', (s) => `access_token = "${s}"`, true],
  ['assignment-bare', (s) => `secret=${s}`, false],
  ['assignment-quoted', (s) => `password: "${s}"`, true],
  ['assignment-aws-export', (s) => `export AWS_SECRET_ACCESS_KEY=${s}`, false],
  ['assignment-github-env', (s) => `export GITHUB_TOKEN="${s}"`, true],
  ['assignment-env-prefix', (s) => `TOKEN=${s} ./deploy.sh`, false],
  ['assignment-space-separated', (s) => `aws configure set aws_secret_access_key ${s}`, false],
  ['url-userinfo-password', (s) => `git clone https://user:${s}@github.com/o/r.git`, false],
  ['url-userinfo-username', (s) => `git clone https://${s}@github.com/o/r.git`, false],
  ['multiline-context', (s) => `first line\nAuthorization: Bearer ${s}\nkeep-this-line`, false],
];

const TRAILING_CONTEXTS: ReadonlyArray<readonly [string, string]> = [
  ['none', ''],
  ['flag', ' --verbose'],
  ['chained-command', ' && echo done'],
  ['next-line', '\ntrailing-line'],
  ['closing-quote', '"'],
];

type Composition = { readonly id: string; readonly input: string };

function compositions(): readonly Composition[] {
  const built: Composition[] = [];
  for (const [bodyId, secret] of SECRET_BODIES) {
    const carriesWhitespace = /\s/.test(secret);
    for (const [introducerId, introduce, quoted] of INTRODUCERS) {
      if (carriesWhitespace && !quoted) continue;
      for (const [contextId, trailing] of TRAILING_CONTEXTS) {
        built.push({
          id: `${introducerId} × ${bodyId} × ${contextId}`,
          input: `${introduce(secret)}${trailing}`,
        });
      }
    }
  }
  return built;
}

/** Lines that carry a marker, which are the only lines the invariant constrains. */
function markerLines(output: string): readonly string[] {
  return output.split(/\r\n|[\r\n]/).filter((line) => line.includes('[REDACTED]'));
}

function tracesOn(line: string): readonly string[] {
  return NEEDLE_TRACES.filter((trace) => line.includes(trace));
}

function label(command: string): string {
  return redactBackgroundCommand({ command, collapseAbsolutePath: (absolutePath) => absolutePath });
}

/**
 * The one shape where a needle can still outlive the marker, and why it is not a same-line
 * violation: the header sits inside a shell argument whose quote is *inferred* from the line, and
 * the credential contains a literal newline, so the inferred quote is not trusted past the line it
 * was read on. Trusting it further is what would let an apostrophe in prose ("can't") blank the
 * remainder of a bug report. The marker's own line carries no credential material.
 */
const CROSS_LINE_RESIDUAL = /^header-in-(curl-argument|single-quoted-argument) × embedded-newline/;

describe('redaction invariant — a marker never stands beside surviving credential material', () => {
  it('holds for every generated (introducer × secret × trailing context) composition', () => {
    const violations: string[] = [];
    for (const { id, input } of compositions()) {
      for (const [surface, output] of [
        ['bug-report', redactBugReportSensitiveText(input)],
        ['label', label(input)],
      ] as const) {
        for (const line of markerLines(output)) {
          const survivors = tracesOn(line);
          if (survivors.length > 0) {
            violations.push(`${surface} · ${id}\n  in : ${JSON.stringify(input)}\n  out: ${JSON.stringify(output)}\n  survived: ${survivors.join(', ')}`);
          }
        }
      }
    }
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  it('leaves no credential material anywhere once a marker is emitted, outside one declared cross-line shape', () => {
    // Stronger than the same-line invariant and therefore reported separately: the marker's line is
    // clean above, and here the WHOLE text is. Only the inferred-quote-plus-newline shape is exempt.
    const violations: string[] = [];
    for (const { id, input } of compositions()) {
      if (CROSS_LINE_RESIDUAL.test(id)) continue;
      for (const [surface, output] of [
        ['bug-report', redactBugReportSensitiveText(input)],
        ['label', label(input)],
      ] as const) {
        if (!output.includes('[REDACTED]')) continue;
        const survivors = tracesOn(output);
        if (survivors.length > 0) {
          violations.push(`${surface} · ${id}\n  in : ${JSON.stringify(input)}\n  out: ${JSON.stringify(output)}\n  survived: ${survivors.join(', ')}`);
        }
      }
    }
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  it('is a fixed point: re-scrubbing scrubbed output changes nothing', () => {
    for (const { id, input } of compositions()) {
      const once = redactBugReportSensitiveText(input);
      expect(redactBugReportSensitiveText(once), id).toBe(once);
    }
  });

  it('emits no marker for text that carries no credential', () => {
    const benign = [
      'yarn test:unit -- backgroundTask',
      'sort --key 2 file.txt',
      'git clone ssh://git@github.com/o/r.git',
      'curl https://example.test:8443/v1/things',
      "the daemon can't parse the header; retrying",
      'rg -n "authorization" src/',
      'deploy --token --verbose',
      'Authorization:',
      'Authorization: ""',
    ];
    for (const input of benign) {
      expect(redactBugReportSensitiveText(input), input).toBe(input);
    }
  });
});
