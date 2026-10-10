import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAndroidAabFixture } from './android-elf.mjs';

const submit = fileURLToPath(new URL('../submit.mjs', import.meta.url));

export function createExpoSubmitFixture(t, { cloud = false, sourceMismatch = false, versionMismatch = false, commitFailure = false, dryRun = false, wrongTrack = false, misaligned = false, nonproduction = false, latest = false, pendingLatest = false, environment, platform = 'android', submitFailure = false } = {}) {
  const selectedEnvironment = environment ?? (nonproduction ? 'preview' : 'production');
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
  const easConfig = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../apps/ui/eas.json', import.meta.url)), 'utf8'));
  easConfig.submit.production.android = { ...easConfig.submit.production.android, track: wrongTrack ? 'internal' : 'production', releaseStatus: 'completed' };
  const easJson = JSON.stringify(easConfig);
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
      appendFileSync(${JSON.stringify(marker)},JSON.stringify({kind:'eas',args,appEnv:options.env.APP_ENV,profile:JSON.parse(readFileSync(options.cwd+'/eas.json','utf8')).submit.production.android})+'\\n');
      if(args.includes('build:list')) {
        const status=args[args.indexOf('--status')+1];
        if(${pendingLatest} && status==='in-progress') return JSON.stringify([${JSON.stringify(pendingBuild)}]);
        return JSON.stringify(status==='finished'?[${JSON.stringify(build)}]:[]);
      }
      if(args.includes('build:view')) return JSON.stringify(args.includes('newer-pending')?${JSON.stringify(pendingBuild)}:${JSON.stringify(build)});
      if(!args.includes('submit')) throw new Error('Unexpected EAS command');
      if(${submitFailure}) throw new Error('fixture submit failure');
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
  const args = ['--import', preloadPath, submit, '--environment', selectedEnvironment, '--platform', platform, '--project-dir', projectDir, '--app-version', '1.2.3', '--source-sha', sourceSha, '--release-id', 'r1', '--release-notes-json', bundlePath, ...(latest ? [] : cloud ? ['--id', 'exact-build'] : ['--path', dryRun ? path.join(dir, 'future.aab') : aabPath]), ...(versionMismatch ? ['--android-version-code', '41'] : []), ...(dryRun ? ['--dry-run'] : [])];
  const result = spawnSync(process.execPath, args, { cwd: fileURLToPath(new URL('../../../../', import.meta.url)), env: { ...process.env, CI: '1', EXPO_TOKEN: 'fixture', GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: credentialJson, HAPPIER_EXPO_SUBMIT_APP_ENV: '', APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n' }, encoding: 'utf8' });
  return { result, calls: readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)), restored: readFileSync(path.join(projectDir, 'eas.json'), 'utf8') === easJson, whatsNew };
}
