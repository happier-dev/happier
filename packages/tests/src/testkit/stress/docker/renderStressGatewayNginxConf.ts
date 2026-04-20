type StressGatewayAffinityMode = 'none' | 'header-hash';

function normalizeHeaderNameToNginxVariableName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function renderUpstreamBlock(params: {
  upstreamApiTargets: readonly string[];
  affinity: StressGatewayAffinityMode;
  stickyHeaderName: string;
}): string {
  if (params.upstreamApiTargets.length === 0) {
    return '';
  }

  if (params.upstreamApiTargets.length === 1) {
    return '';
  }

  const hashDirective = params.affinity === 'header-hash'
    ? `  hash $http_${normalizeHeaderNameToNginxVariableName(params.stickyHeaderName)} consistent;\n`
    : '';
  const serverLines = params.upstreamApiTargets
    .map((target) => `  server ${target};`)
    .join('\n');

  return `upstream happier_api_upstream {\n${hashDirective}${serverLines}\n}\n\n`;
}

export function renderStressGatewayNginxConf(params: Readonly<{
  upstreamApiTargets?: readonly string[];
  affinity?: StressGatewayAffinityMode;
  stickyHeaderName?: string;
  workerConnections?: number;
  workerRlimitNoFile?: number;
  websocketReadTimeoutSeconds?: number;
  websocketSendTimeoutSeconds?: number;
}> = {}): string {
  const upstreamApiTargets = params.upstreamApiTargets?.length ? [...params.upstreamApiTargets] : ['api:53288'];
  const affinity = params.affinity ?? 'none';
  const stickyHeaderName = params.stickyHeaderName ?? 'X-Happier-Sticky-Key';
  const upstreamVariable = upstreamApiTargets.length > 1 ? 'http://happier_api_upstream' : `http://${upstreamApiTargets[0]}`;
  const workerConnections = params.workerConnections ?? 16_384;
  const workerRlimitNoFile = params.workerRlimitNoFile ?? 65_535;
  const websocketReadTimeoutSeconds = params.websocketReadTimeoutSeconds ?? 3600;
  const websocketSendTimeoutSeconds = params.websocketSendTimeoutSeconds ?? 3600;

  return `worker_processes auto;
worker_rlimit_nofile ${workerRlimitNoFile};

events {
  worker_connections ${workerConnections};
}

http {
  map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}

  resolver 127.0.0.11 valid=10s ipv6=off;
  access_log /var/log/nginx/access.log combined;
  error_log /var/log/nginx/error.log warn;

${renderUpstreamBlock({
  upstreamApiTargets,
  affinity,
  stickyHeaderName,
})}  server {
  listen 8080;
  server_name _;

  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-Port $server_port;
  proxy_set_header X-Forwarded-Proto $scheme;

  location /health {
    proxy_pass ${upstreamVariable}/health;
  }

  location /metrics {
    proxy_pass ${upstreamVariable}/metrics;
  }

  location /nginx_status {
    stub_status;
    access_log off;
  }

  location /v1/updates {
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout ${websocketReadTimeoutSeconds}s;
    proxy_send_timeout ${websocketSendTimeoutSeconds}s;
    proxy_pass ${upstreamVariable};
  }

  location /v1/ {
    proxy_pass ${upstreamVariable};
  }

  location /v2/ {
    proxy_pass ${upstreamVariable};
  }

  location /files/ {
    proxy_pass ${upstreamVariable};
  }
}
}
`;
}
