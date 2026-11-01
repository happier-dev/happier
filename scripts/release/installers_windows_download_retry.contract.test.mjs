import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

for (const powerShell of ['powershell.exe', 'pwsh']) {
  const available = spawnSync(powerShell, ['-NoProfile', '-Command', 'exit 0']).status === 0;
  for (const helper of ['Invoke-InstallerWebRequestWithRetry', 'Invoke-InstallerRestMethodWithRetry']) {
    for (const scenario of ['rejected', 'transient', 'forbidden', 'anonymous-rejected']) {
      test(`${powerShell} ${helper} handles ${scenario} credentials`, {
        skip: !available && 'PowerShell is unavailable',
      }, async (t) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-installer-ps-http-'));
        t.after(() => rm(root, { recursive: true, force: true }));
        const authorizations = [];
        const payload = '{"assets":[]}';
        const server = createServer((request, response) => {
          authorizations.push(request.headers.authorization ?? null);
          const status = scenario === 'forbidden' ? 403 : scenario === 'anonymous-rejected' ? 401
            : authorizations.length === 1 ? (scenario === 'rejected' ? 401 : 502) : 200;
          response.writeHead(status, { 'Content-Type': 'application/json' });
          response.end(payload);
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        t.after(() => new Promise((resolve) => server.close(resolve)));
        const source = await readFile(join(repoRoot, 'scripts/release/installers/install.ps1'), 'utf8');
        const functions = source.match(/^function (?:Test-InstallerWebExceptionStatus|Test-InstallerTransientWebException|Remove-InstallerGitHubTokenAfterFailure|Invoke-InstallerWebRequestWithRetry|Invoke-InstallerRestMethodWithRetry) \{[\s\S]*?^}/gm);
        assert.ok(functions?.length >= 3, 'expected installer request owners');
        const download = helper === 'Invoke-InstallerWebRequestWithRetry';
        const script = [
          "$ErrorActionPreference = 'Stop'", "$WarningPreference = 'Stop'", "$env:HAPPIER_NO_ANIMATION = '1'",
          ...functions,
          '$headers = @{ Accept = "application/vnd.github+json" }',
          ...(scenario === 'anonymous-rejected' ? [] : ['$headers.Authorization = "Bearer fixture-token"']),
          '$failed = $false',
          'try {',
          `  $result = ${helper} -Uri 'http://127.0.0.1:${server.address().port}/release' -Headers $headers${download ? " -OutFile '" + join(root, 'asset').replaceAll("'", "''") + "'" : ''}`,
          ...(download ? [] : ['  if ($null -eq $result.assets) { throw "Missing release metadata" }']),
          '} catch { $failed = $true }',
          `if ($failed -ne $${['forbidden', 'anonymous-rejected'].includes(scenario) ? 'true' : 'false'}) { throw "Unexpected request outcome" }`,
          `if ($headers.ContainsKey('Authorization') -ne $${['transient', 'forbidden'].includes(scenario) ? 'true' : 'false'}) { throw "Unexpected authentication state" }`,
          'Write-Output "request-verified"',
        ].join('\n');
        const child = spawn(powerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });
        const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
        assert.equal(status, 0, stdout + stderr);
        assert.match(stdout, /request-verified/);
        if (download && !['forbidden', 'anonymous-rejected'].includes(scenario)) {
          assert.equal(await readFile(join(root, 'asset'), 'utf8'), payload);
        }
        assert.deepEqual(authorizations, scenario === 'rejected' ? ['Bearer fixture-token', null]
          : scenario === 'transient' ? ['Bearer fixture-token', 'Bearer fixture-token']
          : scenario === 'forbidden' ? ['Bearer fixture-token'] : [null]);
      });
    }
  }
}

test('install.ps1 retries transient GitHub installer downloads and release metadata fetches', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(trimmed, /function Invoke-InstallerWebRequestWithRetry\b/i);
  assert.match(trimmed, /\$retryableStatusCodes\s*=\s*@\(404,\s*502,\s*503,\s*504\)/i);
  assert.match(trimmed, /\$params\s*=\s*@\{\s*Uri\s*=\s*\$Uri;\s*UseBasicParsing\s*=\s*\$true\s*\}/i);
  assert.match(trimmed, /Copy-OrDownloadInstallerAsset[\s\S]*Invoke-InstallerWebRequestWithRetry -Uri \$Source -Headers \$GitHubHeaders -OutFile \$DestinationPath/i);
  assert.match(trimmed, /Invoke-InstallerWebRequestWithRetry -Uri \$MinisignPubKeyUrl -OutFile \$TargetPath/i);
  assert.match(trimmed, /\$release\s*=\s*Invoke-InstallerRestMethodWithRetry -Uri "https:\/\/api\.github\.com\/repos\/\$Repo\/releases\/tags\/\$tag" -Headers \$GitHubHeaders/i);
});
