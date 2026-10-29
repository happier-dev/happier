/** Credential-free choices for the existing MCP Add Action; not configured catalog rows. */
export const MCP_SERVER_CATALOG_SUGGESTIONS_V1 = [
  { id: 'cloudflare-api', title: 'Cloudflare API',
    description: 'Connect Cloudflare API tools with OAuth. Code Mode execution requires tool approval.',
    url: 'https://mcp.cloudflare.com/mcp', oauth: true },
  { id: 'cloudflare-docs', title: 'Cloudflare Docs',
    description: 'Search Cloudflare documentation without signing in.',
    url: 'https://docs.mcp.cloudflare.com/mcp', oauth: false },
  { id: 'cloudflare-browser', title: 'Cloudflare Browser Run',
    description: 'Connect browser tools with OAuth. Browser activity can use billable Cloudflare resources.',
    url: 'https://browser.mcp.cloudflare.com/mcp', oauth: true },
  { id: 'cloudflare-containers', title: 'Cloudflare Containers',
    description: 'Connect container tools with OAuth. Container activity can use billable Cloudflare resources.',
    url: 'https://containers.mcp.cloudflare.com/mcp', oauth: true },
] as const;
