import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createBrowserTelemetryRoute } from './route.mjs';

function readOtelPairs(encoded = '') {
    return Object.fromEntries(encoded.split(',').flatMap(pair => {
        const separator = pair.indexOf('=');
        return separator < 0 ? [] : [[pair.slice(0, separator).trim(), decodeURIComponent(pair.slice(separator + 1).trim())]];
    }));
}

export async function createFixtureServer(environment = process.env) {
    const resources = readOtelPairs(environment.OTEL_RESOURCE_ATTRIBUTES);
    const headers = readOtelPairs(environment.OTEL_EXPORTER_OTLP_HEADERS);
    const token = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1].match(/^Bearer (\S+)$/i)?.[1];
    const endpoint = environment.OTEL_EXPORTER_OTLP_ENDPOINT;
    const serviceVersion = environment.FIXTURE_APP_REVISION;
    const deploymentEnvironment = resources['deployment.environment.name'];
    const handleTelemetry = endpoint && token && serviceVersion && deploymentEnvironment && createBrowserTelemetryRoute({
        endpoint,
        token,
        serviceName: environment.OTEL_SERVICE_NAME ?? resources['service.name'] ?? 'dbw-f18-browser',
        serviceVersion,
        environment: deploymentEnvironment,
    });
    const assets = new Map(await Promise.all([
        ['/', './index.html', 'text/html; charset=utf-8'],
        ['/browser.js', './browser.js', 'text/javascript; charset=utf-8'],
        ['/browserChecks.min.js', './public/browserChecks.min.js', 'text/javascript; charset=utf-8'],
    ].map(async ([url, path, type]) => [url, { type, contents: await readFile(new URL(path, import.meta.url)) }])));

    return createServer(async (request, response) => {
        if (request.url === '/api/telemetry') {
            if (!handleTelemetry) { response.writeHead(503).end(); return; }
            try {
                const origin = environment.FIXTURE_APP_ORIGIN ?? `http://${request.headers.host}`;
                const telemetryRequest = new Request(new URL(request.url, origin), {
                    method: request.method,
                    headers: request.headers,
                    ...(request.method === 'POST' ? { body: Readable.toWeb(request), duplex: 'half' } : {}),
                });
                const result = await handleTelemetry(telemetryRequest);
                response.writeHead(result.status).end();
            } catch {
                response.writeHead(400).end();
            }
            return;
        }
        const asset = request.method === 'GET' && assets.get(request.url);
        if (asset) { response.writeHead(200, { 'content-type': asset.type }).end(asset.contents); return; }
        if (request.url === '/health') { response.writeHead(200).end('ready'); return; }
        response.writeHead(404).end();
    });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const server = await createFixtureServer();
    server.listen(3000, '0.0.0.0');
}
