import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { openOwnServerDeploymentStageLog } from '@/deployments/targets/ownServer/stageLog';

it('streams native output only after split-byte secret redaction and preserves plain values', async () => {
    const redaction = createProviderRedactionLease({ values: ['private-猫-token'] });
    const chunks: { stream: 'stdout' | 'stderr'; text: string }[] = [];
    const io = createProjectNativeToolchainIoForHost({ async resolveTool() { return null; } });
    const deploymentRoot = await mkdtemp(join(tmpdir(), 'happier-native-stage-'));
    const stage = await openOwnServerDeploymentStageLog({ deploymentRoot, environmentInstanceId: 'environment',
        deploymentId: 'deployment', machineId: 'machine', installationId: 'installation' });
    try {
        const request = {
            command: process.execPath,
            args: ['-e', "const b=Buffer.from('PORT=3000 private-猫-token done\\n');process.stdout.write(b.subarray(0,21));setTimeout(()=>{process.stdout.write(b.subarray(21));process.stderr.write('private-猫-token error\\n')},20)"],
            cwd: process.cwd(), env: {},
            output: { redaction, onChunk(stream: 'stdout' | 'stderr', bytes: Uint8Array) {
                stage.appendRedacted(stream, bytes);
                chunks.push({ stream, text: Buffer.from(bytes).toString('utf8') });
            } },
        };
        const result = await io.run(request);
        expect(chunks.filter(chunk => chunk.stream === 'stdout').map(chunk => chunk.text).join('')).toBe('PORT=3000 [REDACTED] done\n');
        expect(chunks.filter(chunk => chunk.stream === 'stderr').map(chunk => chunk.text).join('')).toBe('[REDACTED] error\n');
        expect(result.stdout).toBe('PORT=3000 [REDACTED] done\n');
        expect(result.stderr).toBe('[REDACTED] error\n');
        stage.assertWritten(); await stage.close();
        const persisted = await readFile(join(deploymentRoot, 'environment', 'releases', 'deployment', '.happier', 'deploy.log'), 'utf8');
        // Independent stream tails can interleave at settlement; the file
        // preserves the supervisor's sanitized emission order exactly.
        expect(persisted).toBe(chunks.map(chunk => chunk.text).join(''));
        expect(persisted).toContain('PORT=3000');
        expect(persisted).toContain('[REDACTED]');
        expect(persisted).not.toContain('private-猫-token');
    } finally {
        redaction.close(); await stage.close();
        await rm(deploymentRoot, { recursive: true, force: true });
    }
});
