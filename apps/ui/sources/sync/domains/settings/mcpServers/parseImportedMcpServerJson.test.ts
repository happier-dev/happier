import { describe, expect, it } from 'vitest';

import { parseImportedMcpServerJson } from './parseImportedMcpServerJson';

describe('parseImportedMcpServerJson', () => {
    it('parses root mcpServers stdio config', () => {
        const result = parseImportedMcpServerJson(`{
          "mcpServers": {
            "playwright": {
              "command": "npx",
              "args": ["-y", "@playwright/mcp@latest"],
              "env": {
                "PLAYWRIGHT_HEADLESS": "1"
              }
            }
          }
        }`);

        expect(result.errors).toEqual([]);
        expect(result.inputs).toEqual([]);
        expect(result.servers).toHaveLength(1);
        expect(result.servers[0]).toMatchObject({
            name: 'playwright',
            transport: 'stdio',
            stdio: {
                command: 'npx',
                args: ['-y', '@playwright/mcp@latest'],
            },
            env: {
                PLAYWRIGHT_HEADLESS: { t: 'literal', v: '1' },
            },
            enabled: true,
        });
    });

    it('accepts a server title field', () => {
        const result = parseImportedMcpServerJson(`{
          "mcpServers": {
            "playwright": {
              "title": "Playwright MCP",
              "command": "npx",
              "args": ["-y", "@playwright/mcp@latest"]
            }
          }
        }`);

        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.servers).toHaveLength(1);
        expect(result.servers[0]).toMatchObject({
            name: 'playwright',
            title: 'Playwright MCP',
            transport: 'stdio',
        });
    });

    it('parses nested mcp.servers and extracts input references', () => {
        const result = parseImportedMcpServerJson(`{
          "mcp": {
            "inputs": {
              "github_token": {
                "type": "promptString",
                "password": true,
                "description": "GitHub token"
              }
            },
            "servers": {
              "github": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-github"],
                "env": {
                  "GITHUB_TOKEN": "\${input:github_token}"
                }
              }
            }
          }
        }`);

        expect(result.errors).toEqual([]);
        expect(result.inputs).toEqual([
            {
                inputId: 'github_token',
                title: 'github_token',
                description: 'GitHub token',
                secret: true,
                suggestedEnvVarName: 'GITHUB_TOKEN',
            },
        ]);
        expect(result.servers[0]).toMatchObject({
            name: 'github',
            transport: 'stdio',
            env: {
                GITHUB_TOKEN: {
                    t: 'input',
                    inputId: 'github_token',
                },
            },
        });
    });

    it('parses multiple servers from a root servers object and keeps enablement metadata', () => {
        const result = parseImportedMcpServerJson(`{
          "servers": {
            "playwright": {
              "command": "npx",
              "args": ["-y", "@playwright/mcp@latest"]
            },
            "context7": {
              "url": "https://mcp.example.com",
              "transport": "http",
              "enabled": false,
              "headers": {
                "Authorization": "Bearer test-token"
              }
            }
          }
        }`);

        expect(result.errors).toEqual([]);
        expect(result.servers).toHaveLength(2);
        expect(result.servers).toMatchObject([
            {
                name: 'playwright',
                transport: 'stdio',
                enabled: true,
            },
            {
                name: 'context7',
                transport: 'http',
                enabled: false,
                remote: {
                    url: 'https://mcp.example.com',
                    headers: {
                        Authorization: { t: 'literal', v: 'Bearer test-token' },
                    },
                },
            },
        ]);
    });

    it('finds MCP server containers nested inside common host wrappers', () => {
        const result = parseImportedMcpServerJson(`{
          "copilot": {
            "mcp": {
              "servers": {
                "github": {
                  "command": "npx",
                  "args": ["-y", "@modelcontextprotocol/server-github"]
                }
              }
            }
          }
        }`);

        expect(result.errors).toEqual([]);
        expect(result.servers).toHaveLength(1);
        expect(result.servers[0]).toMatchObject({
            name: 'github',
            transport: 'stdio',
            stdio: {
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-github'],
            },
        });
    });

    it('surfaces unsupported fields as warnings instead of dropping them silently', () => {
        const result = parseImportedMcpServerJson(`{
          "servers": {
            "context7": {
              "command": "npx",
              "args": ["-y", "@upstash/context7-mcp@latest"],
              "envFile": ".env.local",
              "cwd": "/tmp/repo"
            }
          }
        }`);

        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([
            'context7: unsupported field "cwd"',
            'context7: unsupported field "envFile"',
        ]);
    });
});
