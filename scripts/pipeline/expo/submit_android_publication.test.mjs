import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAndroidAabFixture } from './fixtures/android-elf.mjs';

const submit = fileURLToPath(new URL('./submit.mjs', import.meta.url));

test('0.3 nonproduction submissions preserve EAS profile status when no override is requested', (t) => {
  for (const [environment, configuredStatus] of [['preview', undefined], ['publicdev', 'draft']]) {
    const dir = mkdtempSync(path.join(tmpdir(), 'play-submit-profile-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const marker = path.join(dir, 'profile.json');
    const aabPath = createAndroidAabFixture(dir);
    const original = JSON.stringify({ submit: { [environment]: { android: { track: 'internal', ...(configuredStatus ? { releaseStatus: configuredStatus } : {}) } } } });
    writeFileSync(path.join(dir, 'eas.json'), original);
    const stub = `data:text/javascript,${encodeURIComponent(`
      import {readFileSync,writeFileSync} from 'node:fs';
      export function execFileSync(cmd,args,options) {
        if(cmd!=='npx'||!args.includes('submit')) throw new Error('Unexpected CLI boundary');
        writeFileSync(${JSON.stringify(marker)},readFileSync(options.cwd+'/eas.json','utf8'));
        return '';
      }
    `)}`;
    const loaderPath = path.join(dir, 'loader.mjs');
    writeFileSync(loaderPath, `export async function resolve(specifier,context,next) { if(specifier==='node:child_process' && context.parentURL===${JSON.stringify(pathToFileURL(submit).href)}) return {url:${JSON.stringify(stub)},shortCircuit:true}; return next(specifier,context); }`);
    const preloadPath = path.join(dir, 'preload.mjs');
    writeFileSync(preloadPath, `import {register} from 'node:module'; register(${JSON.stringify(pathToFileURL(loaderPath).href)},import.meta.url);`);
    const result = spawnSync(process.execPath, ['--import', preloadPath, submit, '--environment', environment, '--platform', 'android', '--project-dir', dir, '--path', aabPath, '--wait', 'false'], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: { ...process.env, CI: '1', EXPO_TOKEN: 'fixture', GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(marker, 'utf8'), original);
    assert.equal(readFileSync(path.join(dir, 'eas.json'), 'utf8'), original);
    assert.doesNotMatch(result.stdout, /publication_submitted|Google Play/);
  }
});

test('production Android refuses missing Play credentials before any EAS submission', () => {
  const result = spawnSync(process.execPath, [submit, '--environment', 'production', '--platform', 'android', '--dry-run'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    env: { ...process.env, CI: '1', EXPO_TOKEN: 'fixture', GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing_play_credential/);
  assert.doesNotMatch(result.stdout, /eas-cli@.*submit/);
});

function submissionFixture(t, { cloud = false, sourceMismatch = false, versionMismatch = false, commitFailure = false, dryRun = false, wrongTrack = false, misaligned = false, nonproduction = false, latest = false, pendingLatest = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'play-submit-flow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundlePath = path.join(dir, 'notes.json');
  const sourceSha = 'a'.repeat(40);
  const whatsNew = 'Exact approved notes.\n Preserve authored spacing.';
  writeFileSync(bundlePath, JSON.stringify({ schemaVersion: 2, kind: 'happier.release-notes.projection.v2', release: { id: 'r1', sourceSha, components: { ui: '1.2.3' } }, projections: { playStore: { whatsNew } } }));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credentialJson = JSON.stringify({ type: 'service_account', client_email: 'fixture@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const projectDir = path.join(dir, 'project');
  mkdirSync(projectDir);
  const easJson = JSON.stringify({ submit: {
    production: { android: { track: wrongTrack ? 'internal' : 'production', releaseStatus: 'completed' } },
    preview: { android: { track: 'internal', releaseStatus: 'draft' } },
  } });
  writeFileSync(path.join(projectDir, 'eas.json'), easJson);
  const aabPath = createAndroidAabFixture(dir, { alignment: misaligned ? '4k' : '16k' });
  const marker = path.join(dir, 'calls.jsonl');
  writeFileSync(marker, '');
  const build = { id: 'exact-build', platform: 'ANDROID', status: 'FINISHED', createdAt: '2026-10-09T10:00:00Z', buildProfile: 'production', gitCommitHash: sourceMismatch ? 'b'.repeat(40) : sourceSha, appVersion: '1.2.3', appBuildVersion: '4242', artifacts: { applicationArchiveUrl: 'https://fixture.example/build.aab' } };
  const pendingBuild = { ...build, id: 'newer-pending', status: 'IN_PROGRESS', createdAt: '2026-10-09T11:00:00Z' };
  const stub = `data:text/javascript,${encodeURIComponent(`
    import {appendFileSync, readFileSync} from 'node:fs';
    export function execFileSync(cmd,args,options) {
      if(cmd!=='npx') throw new Error('Unexpected CLI boundary');
      appendFileSync(${JSON.stringify(marker)},JSON.stringify({kind:'eas',args,profile:JSON.parse(readFileSync(options.cwd+'/eas.json','utf8')).submit.production.android})+'\\n');
      if(args.includes('build:list')) {
        const status=args[args.indexOf('--status')+1];
        if(${pendingLatest} && status==='in-progress') return JSON.stringify([${JSON.stringify(pendingBuild)}]);
        return JSON.stringify(status==='finished'?[${JSON.stringify(build)}]:[]);
      }
      if(args.includes('build:view')) return JSON.stringify(args.includes('newer-pending')?${JSON.stringify(pendingBuild)}:${JSON.stringify(build)});
      if(!args.includes('submit')) throw new Error('Unexpected EAS command');
      return '';
    }
  `)}`;
  const loaderPath = path.join(dir, 'loader.mjs');
  writeFileSync(loaderPath, `export async function resolve(specifier,context,next) { if(specifier==='node:child_process' && context.parentURL===${JSON.stringify(pathToFileURL(submit).href)}) return {url:${JSON.stringify(stub)},shortCircuit:true}; return next(specifier,context); }`);
  const preloadPath = path.join(dir, 'preload.mjs');
  writeFileSync(preloadPath, `
    import {register} from 'node:module';
    import {appendFileSync,readFileSync} from 'node:fs';
    register(${JSON.stringify(pathToFileURL(loaderPath).href)},import.meta.url);
    globalThis.fetch=async (url,init={})=>{
      appendFileSync(${JSON.stringify(marker)},JSON.stringify({kind:'http',url,method:init.method,body:url.includes('oauth2')?undefined:init.body})+'\\n');
      if(url==='https://fixture.example/build.aab') return new Response(readFileSync(${JSON.stringify(aabPath)}));
      if(url.includes('oauth2')) return Response.json({access_token:'fixture'});
      if(url.endsWith('/edits')) return Response.json({id:'edit-1'});
      if(url.endsWith(':commit')) return ${commitFailure ? 'new Response(null,{status:403})' : "Response.json({id:'edit-1'})"};
      if(init.method==='PUT') return Response.json(JSON.parse(init.body));
      return Response.json({track:'production',releases:[{versionCodes:['4242'],status:'draft'}]});
    };
  `);
  const args = ['--import', preloadPath, submit, '--environment', nonproduction ? 'preview' : 'production', '--platform', 'android', '--project-dir', projectDir, '--app-version', '1.2.3', '--source-sha', sourceSha, '--release-id', 'r1', '--release-notes-json', bundlePath, ...(latest ? [] : cloud ? ['--id', 'exact-build'] : ['--path', dryRun ? path.join(dir, 'future.aab') : aabPath]), ...(versionMismatch ? ['--android-version-code', '41'] : []), ...(dryRun ? ['--dry-run'] : [])];
  const result = spawnSync(process.execPath, args, { cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: { ...process.env, CI: '1', EXPO_TOKEN: 'fixture', GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: credentialJson, HAPPIER_EXPO_SUBMIT_APP_ENV: '' }, encoding: 'utf8' });
  return { result, calls: readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)), restored: readFileSync(path.join(projectDir, 'eas.json'), 'utf8') === easJson, whatsNew };
}

test('misaligned native AAB fails before local or cloud upload and store writes', (t) => {
  for (const cloud of [false, true]) {
    const { result, calls, restored } = submissionFixture(t, { cloud, misaligned: true });
    assert.notEqual(result.status, 0, '4KB ELF must be rejected before submission');
    assert.match(result.stderr, /LOAD alignment 4096/u);
    assert.equal(calls.some((call) => call.kind === 'eas' && call.args.includes('submit')), false);
    assert.equal(calls.some((call) => call.url?.includes('androidpublisher')), false);
    assert.equal(restored, true);
  }
});

test('nonproduction local, exact cloud and latest cloud submissions cannot bypass native verification', (t) => {
  for (const options of [{}, { cloud: true }, { cloud: true, latest: true }]) {
    const { result, calls } = submissionFixture(t, { ...options, nonproduction: true, misaligned: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LOAD alignment 4096/u);
    assert.equal(calls.some((call) => call.kind === 'eas' && call.args.includes('submit')), false);
  }
  const { result, calls } = submissionFixture(t, { nonproduction: true, cloud: true, latest: true });
  assert.equal(result.status, 0, result.stderr);
  const upload = calls.find((call) => call.kind === 'eas' && call.args.includes('submit'));
  assert.ok(upload.args.includes('--id') && upload.args.includes('exact-build'));
  assert.equal(upload.args.includes('--latest'), false);
  assert.equal(calls.some((call) => call.kind === 'http' && call.url.includes('androidpublisher')), false);
});

test('a newer pending latest build never causes upload of the older finished binary', (t) => {
  const { result, calls } = submissionFixture(t, { nonproduction: true, cloud: true, latest: true, pendingLatest: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must finish/u);
  assert.equal(calls.some((call) => call.kind === 'eas' && call.args.includes('submit')), false);
});

test('production submission stages exact AAB then commits approved notes with completed rollout', (t) => {
  for (const cloud of [false, true]) {
    const { result, calls, restored, whatsNew } = submissionFixture(t, { cloud });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"status":"publication_submitted"/);
    const upload = calls.find((call) => call.kind === 'eas' && call.args.includes('submit'));
    assert.equal(upload.profile.releaseStatus, 'draft');
    assert.equal(upload.args.includes('--wait'), true);
    const update = calls.find((call) => call.method === 'PUT');
    const release = JSON.parse(update.body).releases[0];
    assert.deepEqual(release.versionCodes, ['4242']);
    assert.equal(release.status, 'completed');
    assert.deepEqual(release.releaseNotes, [{ language: 'en-US', text: whatsNew }]);
    assert.equal(calls.indexOf(upload) < calls.indexOf(update), true);
    assert.equal(restored, true);
  }
});

test('dry-run plans future exact artifacts without invoking EAS or HTTP', (t) => {
  for (const cloud of [false, true]) {
    const { result, calls, restored } = submissionFixture(t, { dryRun: true, cloud });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls.length, 0);
    assert.equal(restored, true);
    assert.match(result.stdout, /releaseStatus=completed/);
  }
});

test('binary/source mismatches refuse submission; failed commit is nonzero and restores EAS profile', (t) => {
  for (const options of [{ cloud: true, sourceMismatch: true }, { versionMismatch: true }]) {
    const { result, calls, restored } = submissionFixture(t, options);
    assert.notEqual(result.status, 0);
    assert.equal(calls.some((call) => call.kind === 'eas' && call.args.includes('submit')), false);
    assert.equal(restored, true);
  }
  const { result, restored } = submissionFixture(t, { commitFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /play_api_error/);
  assert.equal(restored, true);
  assert.doesNotMatch(result.stdout, /publication_submitted/);
});

test('production cannot upload to a submit profile targeting another track', (t) => {
  const { result, calls } = submissionFixture(t, { wrongTrack: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /production track/i);
  assert.equal(calls.length, 0);
});

test('production Android refuses a moving latest build even with bound notes and credentials', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'play-submit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundlePath = path.join(dir, 'notes.json');
  const sourceSha = 'a'.repeat(40);
  writeFileSync(bundlePath, JSON.stringify({ schemaVersion: 2, kind: 'happier.release-notes.projection.v2', release: { id: 'r1', sourceSha, components: { ui: '1.2.3' } }, projections: { playStore: { whatsNew: 'Approved notes' } } }));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credentialJson = JSON.stringify({ type: 'service_account', client_email: 'fixture@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const result = spawnSync(process.execPath, [submit, '--environment', 'production', '--platform', 'android', '--dry-run', '--android-version-code', '42', '--app-version', '1.2.3', '--source-sha', sourceSha, '--release-id', 'r1', '--release-notes-json', bundlePath], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: { ...process.env, CI: '1', EXPO_TOKEN: 'fixture', GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: credentialJson }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact.*(?:build|artifact)/i);
  assert.doesNotMatch(result.stdout, /eas-cli@.*submit/);
});
