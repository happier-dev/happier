// @ts-check

import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function normalizeNonEmpty(name, value) {
  const v = String(value ?? '').trim();
  if (!v) fail(`Missing ${name}.`);
  return v;
}

function parseHookList(raw) {
  const hooks = [];
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    hooks.push(trimmed);
  }
  return hooks;
}

function hasValidHooks(raw) {
  return parseHookList(raw).length > 0;
}

function resolveDeployUrls({ baseUrl, hooks }) {
  const urls = [];
  for (const hook of hooks) {
    if (/^https?:\/\//i.test(hook)) {
      urls.push(hook);
      continue;
    }
    urls.push(`${baseUrl}/${hook}`);
  }
  return urls;
}

function buildDokployPushPayload({ ref, sha, repository }) {
  const [ownerName = '', repoName = ''] = repository.split('/', 2);
  return {
    ref,
    before: '0'.repeat(40),
    after: sha,
    repository: {
      full_name: repository,
      name: repoName,
      owner: { name: ownerName },
      default_branch: 'main',
    },
  };
}

function resolveShaWithGh({ repository, refName }) {
  const ref = encodeURIComponent(refName);
  const json = execFileSync(
    'gh',
    ['api', `repos/${repository}/git/ref/heads/${ref}`, '--jq', '.object.sha'],
    {
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );
  return String(json ?? '').trim();
}

function resolveShaWithGhDryRun({ repository, refName }) {
  const ref = encodeURIComponent(refName);
  console.log(`[dry-run] gh api repos/${repository}/git/ref/heads/${ref} --jq .object.sha`);
  return '0'.repeat(40);
}

async function postWebhook({ url, headers, payload, dryRun, label, index }) {
  // Avoid leaking full hook URLs if operators configure full URLs that may embed secrets.
  console.log(`POST deploy hook (${label}) #${index}`);
  console.log('Request headers: Content-Type, X-GitHub-Event, X-GitHub-Delivery, CF-Access-Client-Id, CF-Access-Client-Secret');
  console.log(`Request body: ${JSON.stringify(payload)}`);

  if (dryRun) return;

  const body = JSON.stringify(payload);
  const attempts = 3;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      const text = await resp.text();
      console.log(`Response status: ${resp.status}`);
      if (text) {
        console.log('Response body:');
        console.log(text);
      } else {
        console.log('Response body: <empty>');
      }
      if (resp.status >= 200 && resp.status < 300) return;
      throw new Error(`Non-2xx response: ${resp.status}`);
    } catch (err) {
      if (attempt === attempts) throw err;
      console.log(`Webhook attempt ${attempt}/${attempts} failed; retrying...`);
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      component: { type: 'string' },
      repository: { type: 'string' },
      'ref-name': { type: 'string' },
      sha: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const environment = normalizeNonEmpty('--environment', values.environment);
  const component = normalizeNonEmpty('--component', values.component);
  const repository = normalizeNonEmpty('--repository', values.repository);
  const refName = String(values['ref-name'] ?? '').trim() || `deploy/${environment}/${component}`;
  const dryRun = values['dry-run'] === true;

  if (!['production', 'preview'].includes(environment)) {
    fail(`Unsupported environment: ${environment}`);
  }
  if (!['ui', 'server', 'website', 'docs'].includes(component)) {
    fail(`Unsupported component: ${component}`);
  }

  const listsByLabel = (() => {
    switch (component) {
      case 'ui':
        return [['ui', process.env.HAPPIER_UI_DEPLOY_WEBHOOKS ?? '']];
      case 'website':
        return [['website', process.env.HAPPIER_WEBSITE_DEPLOY_WEBHOOKS ?? '']];
      case 'docs':
        return [['docs', process.env.HAPPIER_DOCS_DEPLOY_WEBHOOKS ?? '']];
      case 'server':
        return [
          ['server api', process.env.HAPPIER_SERVER_API_DEPLOY_WEBHOOKS ?? ''],
          ['server worker', process.env.HAPPIER_SERVER_WORKER_DEPLOY_WEBHOOKS ?? ''],
        ];
      default:
        return [];
    }
  })();

  for (const [label, hooksRaw] of listsByLabel) {
    if (hasValidHooks(hooksRaw)) continue;
    if (environment === 'production') {
      fail(`Missing deploy webhook list for '${label}' in production; refusing to silently skip.`);
    }
    console.log(`::notice::No deploy webhook list configured for '${label}' in environment '${environment}'. Skipping deploy trigger.`);
    process.exit(0);
  }

  const clientId = normalizeNonEmpty('CF_WEBHOOK_DEPLOY_CLIENT_ID', process.env.CF_WEBHOOK_DEPLOY_CLIENT_ID);
  const clientSecret = normalizeNonEmpty('CF_WEBHOOK_DEPLOY_CLIENT_SECRET', process.env.CF_WEBHOOK_DEPLOY_CLIENT_SECRET);
  const deployWebhookUrlRaw = normalizeNonEmpty('DEPLOY_WEBHOOK_URL', process.env.DEPLOY_WEBHOOK_URL);
  const baseUrl = deployWebhookUrlRaw.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) {
    fail(`DEPLOY_WEBHOOK_URL must start with http:// or https:// (got: ${baseUrl}).`);
  }

  const branchName = refName;
  const ref = `refs/heads/${branchName}`;
  let sha = String(values.sha ?? '').trim();
  if (!sha) {
    console.log(`Resolving deploy branch SHA with gh: ${refName}`);
    sha = dryRun ? resolveShaWithGhDryRun({ repository, refName }) : resolveShaWithGh({ repository, refName });
  }
  sha = normalizeNonEmpty('--sha', sha);

  console.log(`Dokploy webhook target: ref=${ref} after=${sha}`);

  const payload = buildDokployPushPayload({ ref, sha, repository });
  const headers = {
    'CF-Access-Client-Id': clientId,
    'CF-Access-Client-Secret': clientSecret,
    'Content-Type': 'application/json',
    'X-GitHub-Event': 'push',
    'X-GitHub-Delivery': randomUUID(),
  };

  for (const [label, hooksRaw] of listsByLabel) {
    const hooks = parseHookList(hooksRaw);
    console.log(`Triggering deploy hook(s) for '${label}'...`);
    const urls = resolveDeployUrls({ baseUrl, hooks });
    let index = 0;
    for (const url of urls) {
      index += 1;
      await postWebhook({ url, headers, payload, dryRun, label, index });
    }
    console.log(`Triggered ${urls.length} webhook(s) for '${label}'.`);
  }
}

await main();
