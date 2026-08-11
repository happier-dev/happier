import { describe, expect, it } from 'vitest';

import { BACKGROUND_TASK_LABEL_MAX } from './backgroundTaskRecordV1.js';
import { redactBackgroundCommand } from './backgroundTaskRedaction.js';

/**
 * Stands in for the CLI's canonical home-collapse helper
 * (`apps/cli/src/session/handoff/paths/sessionHandoffPathNormalization.ts#toHomeRelativePath`),
 * which protocol cannot import and deliberately does not re-implement. Sibling-prefix collisions
 * (`/Users/alice` vs `/Users/alice2`) are that helper's contract, not this module's; what is under
 * test here is that every absolute path in the command reaches it and that its answer is used.
 */
function collapseUnderHome(homeDir: string) {
  return (absolutePath: string): string => {
    if (absolutePath === homeDir) return '~';
    if (!absolutePath.startsWith(`${homeDir}/`)) return absolutePath;
    return `~/${absolutePath.slice(homeDir.length + 1)}`;
  };
}

const collapseAbsolutePath = collapseUnderHome('/Users/leeroy');

function redact(command: string): string {
  return redactBackgroundCommand({ command, collapseAbsolutePath });
}

describe('redactBackgroundCommand', () => {
  it('leaves a benign command intact', () => {
    expect(redact('grep -rn "thing" src/')).toBe('grep -rn "thing" src/');
    expect(redact('yarn test:unit -- backgroundTask')).toBe('yarn test:unit -- backgroundTask');
  });

  it('strips a credential sitting in the middle of an otherwise useful command', () => {
    const redacted = redact('curl --token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 https://api.example.test/v1');

    expect(redacted).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(redacted).toContain('curl');
    expect(redacted).toContain('https://api.example.test/v1');
  });

  it('strips every secret in a command that carries several of different shapes', () => {
    const redacted = redact([
      'deploy',
      '--password=hunter2correcthorse',
      '-H "Authorization: abcDEF123ghiJKL456"',
      'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      'PAYLOAD=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpams=',
    ].join(' '));

    expect(redacted).not.toContain('hunter2correcthorse');
    expect(redacted).not.toContain('abcDEF123ghiJKL456');
    expect(redacted).not.toContain('sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');
    expect(redacted).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(redacted).not.toContain('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpams=');
    expect(redacted).toContain('deploy');
  });

  it('removes a secret that straddles the truncation boundary rather than publishing its head', () => {
    // The secret starts before char 120 and ends after it: truncating first would leave a live
    // prefix in the persisted label. Redaction therefore runs before truncation.
    const filler = 'run-the-long-benign-preamble-that-eats-most-of-the-label-budget-and-then-some-more-words-here';
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const command = `${filler} --token=${secret}`;
    expect(command.indexOf(secret)).toBeLessThan(BACKGROUND_TASK_LABEL_MAX);
    expect(command.indexOf(secret) + secret.length).toBeGreaterThan(BACKGROUND_TASK_LABEL_MAX);

    const redacted = redact(command);

    expect(redacted).not.toContain('ghp_');
    expect(redacted).not.toContain('ABCDEFGHIJ');
    expect(redacted.length).toBeLessThanOrEqual(BACKGROUND_TASK_LABEL_MAX);
  });

  it('collapses a home path that sits inside a quoted argument', () => {
    const redacted = redact('rg --files "/Users/leeroy/Documents/happier/apps/cli" -g "*.ts"');

    expect(redacted).toBe('rg --files "~/Documents/happier/apps/cli" -g "*.ts"');
    expect(redacted).not.toContain('/Users/leeroy');
  });

  it('hands every absolute path to the canonical collapser and uses its answer', () => {
    const seen: string[] = [];
    const redacted = redactBackgroundCommand({
      command: 'cp /Users/leeroy/a.txt /var/tmp/b.txt',
      collapseAbsolutePath: (absolutePath) => {
        seen.push(absolutePath);
        return absolutePath === '/Users/leeroy/a.txt' ? '<collapsed>' : absolutePath;
      },
    });

    expect(seen).toEqual(['/Users/leeroy/a.txt', '/var/tmp/b.txt']);
    expect(redacted).toBe('cp <collapsed> /var/tmp/b.txt');
  });

  it('does not mistake a URL authority for an absolute path', () => {
    const seen: string[] = [];
    redactBackgroundCommand({
      command: 'curl https://example.test/v1/things',
      collapseAbsolutePath: (absolutePath) => {
        seen.push(absolutePath);
        return absolutePath;
      },
    });

    expect(seen).toEqual([]);
  });

  it('truncates to a single-line label within the persisted bound', () => {
    const redacted = redact(`echo ${'a'.repeat(400)}`);

    expect(redacted.length).toBeLessThanOrEqual(BACKGROUND_TASK_LABEL_MAX);
    expect(redacted.startsWith('echo aaaa')).toBe(true);
    expect(redacted.endsWith('…')).toBe(true);
  });

  it('flattens newlines and padding so the label is one row of text', () => {
    expect(redact('  npm run build \n   && npm test  ')).toBe('npm run build && npm test');
  });

  it('returns an empty label for empty input rather than a placeholder', () => {
    expect(redactBackgroundCommand({ command: '', collapseAbsolutePath })).toBe('');
    expect(redactBackgroundCommand({ command: '   ', collapseAbsolutePath })).toBe('');
    expect(redactBackgroundCommand({ command: null, collapseAbsolutePath })).toBe('');
    expect(redactBackgroundCommand({ command: undefined, collapseAbsolutePath })).toBe('');
  });

  it('never cuts a label through a surrogate pair', () => {
    // The label is persisted, encrypted and synced; a lone surrogate is an invalid string that
    // fails far from here. The emoji is positioned so a naive slice lands inside it.
    const redacted = redact(`echo ${'a'.repeat(113)}🙂 tail`);
    expect(`echo ${'a'.repeat(113)}🙂 tail`.charCodeAt(BACKGROUND_TASK_LABEL_MAX - 2)).toBeGreaterThanOrEqual(0xd800);

    expect(redacted.length).toBeLessThanOrEqual(BACKGROUND_TASK_LABEL_MAX);
    expect(redacted).toBe(JSON.parse(JSON.stringify(redacted)));
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(redacted)).toBe(false);
  });

  it('strips a credential passed as a separate flag argument', () => {
    const redacted = redact('deploy --token abc123def456ghi789 --verbose');

    expect(redacted).not.toContain('abc123def456ghi789');
    expect(redacted).toContain('--verbose');
  });

  it('keeps a long relative path readable instead of treating it as a high-entropy blob', () => {
    const command = 'rg -n thing apps/ui/sources/components/sessions/agentActivity/row/index.ts';
    expect(command.length).toBeGreaterThan(41);

    expect(redact(command)).toBe(command);
  });

  it('keeps a long relative path readable when its segments carry digits', () => {
    // The path exemption must survive the version numbers and ordinals real repositories use;
    // tightening the entropy rule must not start blanking `…/agentActivity2/row/index7.ts`.
    const command = 'rg -n thing apps/ui/sources/components/sessions/agentActivity2/row/index7.ts';
    expect(command.length).toBeGreaterThan(41);

    expect(redact(command)).toBe(command);
  });

  it('strips a base64 payload whose own alphabet contains slashes', () => {
    // `/` is a standard-base64 character, so exempting every run with two of them switches the
    // rule off exactly where it matters most: the longer the payload, the likelier it survives.
    const key = 'k9/Xz2QvJ8mTr4Nb+Lc7ePw1aYh6Sd0Ug/Fj3ItKoRE=';
    expect(key.length).toBeGreaterThan(41);

    const redacted = redact(`openssl enc -d -aes-256-cbc -K ${key} -in x.bin`);

    expect(redacted).not.toContain(key);
    expect(redacted).not.toContain('Fj3ItKoRE');
    expect(redacted).toContain('openssl');
  });

  it('strips a credential embedded in a URL authority', () => {
    const redacted = redact('git clone https://user:ghp_SHORTBUTREALTOKEN@github.com/o/r.git');

    expect(redacted).not.toContain('ghp_SHORTBUTREALTOKEN');
    expect(redacted).toContain('github.com');
  });

  it('does not let the slashes of a URL scheme buy the path exemption for a payload', () => {
    // The entropy candidate run begins at the `//` of `https://` — `/` is in its own alphabet — so
    // the run inherited two slashes and took the path exemption. That made ANY payload sitting
    // immediately after `://` exempt at any length. The scheme's slashes are not the payload's.
    const payload = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVm';
    expect(payload.length).toBeGreaterThan(41);

    const redacted = redact(`curl -X POST http://localhost/${payload}`);

    expect(redacted).not.toContain(payload);
    expect(redacted).not.toContain('QUJDREVG');
    // …and an ordinary dotless-host URL keeps its path: the run has to look like a payload.
    expect(redact('curl http://localhost/api/v1/things')).toBe('curl http://localhost/api/v1/things');
    expect(redact('curl http://localhost/some-very-long-path-segment-without-any-digits-in-it-at-all'))
      .toBe('curl http://localhost/some-very-long-path-segment-without-any-digits-in-it-at-all');
  });

  it('strips a token carried as a URL username with no password', () => {
    const redacted = redact('git clone https://github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklm@github.com/o/r.git');

    expect(redacted).not.toContain('github_pat_11ABCDEFG0');
    expect(redacted).toContain('github.com');
  });

  it('strips a quoted authorization header carried inside a shell argument', () => {
    const redacted = redact(`curl -H "Authorization: 'Bearer opaque-value-here-1234'" https://api.example.test`);

    expect(redacted).not.toContain('opaque-value-here-1234');
    expect(redacted).toContain('curl');
  });

  it('removes a URL credential that straddles the truncation boundary', () => {
    // Same contract as the flag-argument straddle above, for the shape the header and assignment
    // rules cannot see: the scrub has to happen before the cut, or the label publishes the head of
    // a live password.
    const filler = 'run-the-benign-preamble-that-eats-most-of-the-label-budget-before-the-clone-command-here';
    const secret = 'hunter2correcthorse';
    const command = `${filler} git clone https://user:${secret}@github.com/o/r.git`;
    expect(command.indexOf(secret)).toBeLessThan(BACKGROUND_TASK_LABEL_MAX);
    expect(command.indexOf(secret) + secret.length).toBeGreaterThan(BACKGROUND_TASK_LABEL_MAX);

    const redacted = redact(command);

    expect(redacted).not.toContain('hunter2');
    expect(redacted.length).toBeLessThanOrEqual(BACKGROUND_TASK_LABEL_MAX);
  });
});
