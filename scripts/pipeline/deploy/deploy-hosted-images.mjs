import { parseArgs } from 'node:util';

// Change the image and its documented runtime options; retain operator env bytes.
// API basis: https://docs.dokploy.com/docs/api/reference-application (2026-11-03).
const { values } = parseArgs({ options: { images: { type: 'string' } } });
try {
  const images = JSON.parse(values.images ?? '{}');
  // Same contract as trigger-webhooks.mjs: only production refuses an unconfigured target.
  const environment = process.env.DEPLOY_ENVIRONMENT;
  const hasApplication = Object.keys(images).some((service) => process.env[`DOKPLOY_${service.toUpperCase()}_APPLICATION_ID`]);
  if (environment && environment !== 'production' && !hasApplication) {
    console.log(`::notice::No Dokploy applications configured for environment '${environment}'. Skipping hosted image deployment.`);
    process.exit(0);
  }
  const base = process.env.DOKPLOY_API_URL;
  const key = process.env.DOKPLOY_API_KEY;
  if (!base || !key) throw new Error('DOKPLOY_API_URL and DOKPLOY_API_KEY are required');
  const headers = { 'x-api-key': key, 'content-type': 'application/json' };
  if (process.env.CF_WEBHOOK_DEPLOY_CLIENT_ID) {
    headers['CF-Access-Client-Id'] = process.env.CF_WEBHOOK_DEPLOY_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = process.env.CF_WEBHOOK_DEPLOY_CLIENT_SECRET ?? '';
  }
  async function request(route, body) {
    let response;
    try {
      response = await fetch(`${base.replace(/\/$/, '')}/api/${route}`, {
        method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error('Dokploy request failed; check deployment connectivity');
    }
    if (!response.ok) throw new Error(`Dokploy request failed (${response.status})`);
    // Dokploy v0.30.10's deploy mutation returns void. Only the read needs data.
    if (body) return;
    try { return await response.json(); } catch { throw new Error('Invalid Dokploy response'); }
  }
  const targets = Object.entries(images).map(([service, dockerImage]) => {
    if (!['api', 'worker', 'ui'].includes(service)) throw new Error('Invalid hosted deployment service');
    const imageName = service === 'ui' ? 'webapp' : 'relay-server';
    if (typeof dockerImage !== 'string' || !new RegExp(`^ghcr\\.io/happier-dev/${imageName}:[\\w][\\w.-]*(?:@sha256:[a-f0-9]{64})?$`).test(dockerImage) || /:(latest|preview|dev|stable)$/.test(dockerImage)) {
      throw new Error('Hosted deployment requires an exact versioned GHCR image');
    }
    const applicationId = process.env[`DOKPLOY_${service.toUpperCase()}_APPLICATION_ID`];
    if (!applicationId) throw new Error(`Missing Dokploy application ID for ${service}`);
    return { service, applicationId, dockerImage };
  });
  if (!targets.length) throw new Error('No hosted images selected');
  // JSON key order is caller-controlled during manual redeploys and rollbacks.
  targets.sort((left, right) => Number(right.service === 'api') - Number(left.service === 'api'));
  // Verify the operator switched every selected app before changing any image.
  for (const target of targets) {
    const app = await request(`application.one?applicationId=${encodeURIComponent(target.applicationId)}`);
    if (app.sourceType !== 'docker') throw new Error('Switch selected Dokploy applications to Docker source before deploying');
    const options = target.service === 'ui'
      ? { HAPPIER_WEBAPP_SERVER_URL: process.env.DOKPLOY_UI_SERVER_URL }
      : { HAPPIER_SERVER_FLAVOR: 'full', HAPPIER_DB_PROVIDER: 'postgres', HAPPIER_SERVER_UI_REQUIRED: '0', HAPPIER_SERVER_UI_DIR: '', SERVER_ROLE: target.service, HAPPIER_SOCKET_ADAPTER: 'redis-streams' };
    if (target.service === 'ui' && !options.HAPPIER_WEBAPP_SERVER_URL) throw new Error('DOKPLOY_UI_SERVER_URL is required');
    const marker = '\n# Happier image runtime configuration\n';
    // Replace only our block, preserving operator additions before or after it.
    const endMarker = '# End Happier image runtime configuration\n';
    const original = String(app.env ?? '').replace(/\n# Happier image runtime configuration\n[\s\S]*?\n# End Happier image runtime configuration\n/, '\n');
    target.env = original + (original.endsWith('\n') ? '' : '\n') + marker.slice(1)
      + Object.entries(options).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n' + endMarker;
  }
  for (const { service, applicationId, dockerImage, env } of targets) {
    await request('application.update', { applicationId, dockerImage, env });
    await request('application.deploy', { applicationId, title: `Release ${dockerImage}` });
    console.log(`Dokploy deployment requested: ${service} ${dockerImage}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Hosted image deployment failed');
  process.exitCode = 1;
}
