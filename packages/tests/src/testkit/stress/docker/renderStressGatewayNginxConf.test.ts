import { describe, expect, it } from 'vitest';

import { renderStressGatewayNginxConf } from './renderStressGatewayNginxConf';

describe('renderStressGatewayNginxConf', () => {
  it('renders websocket-aware proxy rules for the canonical full-compose gateway', () => {
    const nginx = renderStressGatewayNginxConf();

    expect(nginx).toContain('worker_processes auto;');
    expect(nginx).toContain('worker_rlimit_nofile 65535;');
    expect(nginx).toContain('events {');
    expect(nginx).toContain('worker_connections 16384;');
    expect(nginx).toContain('http {');
    expect(nginx).toContain('resolver 127.0.0.11');
    expect(nginx).toContain('access_log /var/log/nginx/access.log combined;');
    expect(nginx).toContain('error_log /var/log/nginx/error.log warn;');
    expect(nginx).toContain('location /v1/updates');
    expect(nginx).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(nginx).toContain('proxy_set_header Connection $connection_upgrade;');
    expect(nginx).toContain('location /health');
    expect(nginx).toContain('location /metrics');
    expect(nginx).toContain('location /nginx_status');
    expect(nginx).toContain('stub_status;');
    expect(nginx).toContain('location /v1/');
    expect(nginx).toContain('location /v2/');
    expect(nginx).toContain('location /files/');
    expect(nginx).toContain('proxy_set_header X-Forwarded-Proto $scheme;');
  });

  it('can render a sticky header-hash gateway variant across explicit api upstreams', () => {
    const nginx = renderStressGatewayNginxConf({
      upstreamApiTargets: ['10.10.0.11:53288', '10.10.0.12:53288'],
      affinity: 'header-hash',
      stickyHeaderName: 'X-Happier-Sticky-Key',
    });

    expect(nginx).toContain('upstream happier_api_upstream {');
    expect(nginx).toContain('hash $http_x_happier_sticky_key consistent;');
    expect(nginx).toContain('server 10.10.0.11:53288;');
    expect(nginx).toContain('server 10.10.0.12:53288;');
    expect(nginx).toContain('proxy_pass http://happier_api_upstream;');
  });

  it('can render an unsafe idle-timeout variant for proxy timeout validation scenarios', () => {
    const nginx = renderStressGatewayNginxConf({
      websocketReadTimeoutSeconds: 55,
      websocketSendTimeoutSeconds: 55,
      workerConnections: 32768,
      workerRlimitNoFile: 131072,
    });

    expect(nginx).toContain('worker_rlimit_nofile 131072;');
    expect(nginx).toContain('worker_connections 32768;');
    expect(nginx).toContain('proxy_read_timeout 55s;');
    expect(nginx).toContain('proxy_send_timeout 55s;');
  });
});
