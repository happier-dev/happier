import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    createFiniteProcessCustodyInvocation,
    createWindowsJobCustodyName,
    waitForProcessCustodyHandshake,
} from './processCustody';

// This executable fixture is the native-helper OS boundary, not a replacement
// process owner. It exposes root exit separately from the helper's terminal
// event; only the real Windows Go test proves Job containment and descendants.
const helperFixture = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = JSON.parse(process.env.FIXTURE_CUSTODY_ARGUMENTS);
const job = args.find(arg => arg.startsWith('--job=')).slice('--job='.length);
const handshake = args.find(arg => arg.startsWith('--handshake=')).slice('--handshake='.length);
// The qualified Windows executable is replaced at this OS boundary by a real
// short-lived process. Its witnessed PID is not the carrier PID.
const root = spawn(process.execPath, ['-e', 'process.exit(37)'], { stdio: 'ignore' });
root.once('spawn', () => {
    fs.writeFileSync(handshake, JSON.stringify({v:1,pid:root.pid,job}));
    process.stdout.write(JSON.stringify(args.slice(args.indexOf('--') + 1)) + '\n');
    process.stdout.write('target-pid:' + root.pid + '\n');
});
root.once('exit', code => {
    process.stdout.write('root-exited:' + code + '\n');
    if (!args.includes('--wait-for-job-empty')) process.exit(code);
    process.stdin.once('data', () => process.exit(code));
});
`;

describe('finite Windows process custody invocation', () => {
    it.each([
        { name: 'argv', command: 'C:\\Program Files\\reviewed-tool.exe',
            args: ['with space', 'literal&argument'],
            target: ['C:\\Program Files\\reviewed-tool.exe', 'with space', 'literal&argument'], verbatim: false },
        { name: 'verbatim cmd tail', command: 'C:\\Windows\\System32\\cmd.exe',
            args: '/d /s /c ""C:\\Program Files\\reviewed-tool.cmd" "literal&argument""',
            target: ['C:\\Windows\\System32\\cmd.exe', '/d /s /c ""C:\\Program Files\\reviewed-tool.cmd" "literal&argument""'],
            verbatim: true },
    ])('holds the actual helper after root exit until its whole-job terminal boundary ($name)', async ({ command, args, target, verbatim }) => {
        const root = await mkdtemp(join(tmpdir(), 'finite-custody-contract-'));
        const custody = {
            executablePath: 'qualified-custody-helper.exe',
            jobName: createWindowsJobCustodyName('finite-contract'),
            handshakePath: join(root, 'handshake.json'),
        };
        try {
            const invocation = createFiniteProcessCustodyInvocation({
                custody,
                command,
                args,
            });
            expect(invocation.command).toBe(custody.executablePath);
            expect(invocation.custody).toBe(custody);
            expect(invocation.args.includes('--target-windows-verbatim')).toBe(verbatim);
            const helper = spawn(process.execPath, ['-e', helperFixture], {
                // The platform helper is replaced only at its executable OS
                // boundary so this source contract also runs on Linux/macOS.
                env: { ...process.env, FIXTURE_CUSTODY_ARGUMENTS: JSON.stringify(invocation.args) },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const terminal = once(helper, 'close');
            let exited = false;
            helper.once('exit', () => { exited = true; });
            try {
                let output = '';
                await new Promise<void>((resolve, reject) => {
                    helper.once('error', reject);
                    helper.stdout.on('data', (chunk: Buffer) => {
                        output += chunk.toString('utf8');
                        if (output.includes('root-exited:37\n')) resolve();
                    });
                });
                const established = await waitForProcessCustodyHandshake({
                    handshakePath: custody.handshakePath,
                    jobName: custody.jobName,
                });
                const targetPid = Number(output.split('\n').find((line) => line.startsWith('target-pid:'))?.slice('target-pid:'.length));
                expect(established).toEqual({ pid: targetPid });
                expect(targetPid).toBeGreaterThan(0);
                expect(targetPid).not.toBe(helper.pid);
                expect(JSON.parse(output.split('\n')[0])).toEqual(target);
                // A synchronous native boundary observation can see root exit
                // without converting it into helper/tree settlement.
                await new Promise<void>((resolve) => setImmediate(resolve));
                expect(exited).toBe(false);
                helper.stdin.write('positive-empty\n');
                expect(await terminal).toEqual([37, null]);
            } finally {
                if (helper.exitCode === null) helper.kill();
                await terminal;
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
