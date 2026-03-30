import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSkillsShPromptRegistryAdapter } from './createSkillsShPromptRegistryAdapter';

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Happier Bot',
      GIT_AUTHOR_EMAIL: 'bot@example.com',
      GIT_COMMITTER_NAME: 'Happier Bot',
      GIT_COMMITTER_EMAIL: 'bot@example.com',
    },
  }).trim();
}

async function readResponseBody(value: string): Promise<string> {
  return value;
}

describe('createSkillsShPromptRegistryAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('scans the featured skills.sh source from the public registry instead of the CLI repository', async () => {
    const localRepo = mkdtempSync(join(tmpdir(), 'happier-skills-sh-cli-'));
    try {
      mkdirSync(join(localRepo, 'skills', 'find-skills'), { recursive: true });
      writeFileSync(join(localRepo, 'skills', 'find-skills', 'SKILL.md'), '# Find skills\n', 'utf8');
      git(localRepo, ['init', '-b', 'main']);
      git(localRepo, ['add', '.']);
      git(localRepo, ['commit', '-m', 'init']);

      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        text: async () => await readResponseBody([
          '<html><body>',
          '<a href="/vercel-labs/agent-skills/web-design-guidelines">web-design-guidelines</a>',
          '<a href="/anthropics/skills/frontend-design">frontend-design</a>',
          '</body></html>',
        ].join('')),
      })));

      const adapter = createSkillsShPromptRegistryAdapter();
      const items = await adapter.scanSource({
        source: {
          descriptor: {
            id: 'skills_sh:featured',
            adapterId: 'skills_sh',
            title: 'skills.sh',
            subtitle: 'Featured',
            origin: 'built_in',
          },
          config: {
            repositoryUrl: localRepo,
          },
        },
      });

      expect(items).toEqual([
        expect.objectContaining({
          title: 'web-design-guidelines',
          displayPath: 'vercel-labs/agent-skills/web-design-guidelines',
        }),
        expect.objectContaining({
          title: 'frontend-design',
          displayPath: 'anthropics/skills/frontend-design',
        }),
      ]);
    } finally {
      rmSync(localRepo, { recursive: true, force: true });
    }
  });

  it('uses the skills.sh search API for queried scans', async () => {
    const localRepo = mkdtempSync(join(tmpdir(), 'happier-skills-sh-search-'));
    try {
      mkdirSync(join(localRepo, 'skills', 'find-skills'), { recursive: true });
      writeFileSync(join(localRepo, 'skills', 'find-skills', 'SKILL.md'), '# Find skills\n', 'utf8');
      git(localRepo, ['init', '-b', 'main']);
      git(localRepo, ['add', '.']);
      git(localRepo, ['commit', '-m', 'init']);

      const fetchMock = vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (!url.includes('/api/search?q=design')) {
          throw new Error(`unexpected url: ${url}`);
        }
        return {
          ok: true,
          json: async () => ({
            skills: [
              {
                source: 'vercel-labs/agent-skills',
                skillId: 'web-design-guidelines',
                name: 'web-design-guidelines',
              },
              {
                source: 'anthropics/skills',
                skillId: 'frontend-design',
                name: 'frontend-design',
              },
            ],
          }),
        };
      });
      vi.stubGlobal('fetch', fetchMock);

      const adapter = createSkillsShPromptRegistryAdapter();
      const items = await adapter.scanSource({
        source: {
          descriptor: {
            id: 'skills_sh:featured',
            adapterId: 'skills_sh',
            title: 'skills.sh',
            subtitle: 'Featured',
            origin: 'built_in',
          },
          config: {
            repositoryUrl: localRepo,
          },
        },
        query: 'design',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(items).toEqual([
        expect.objectContaining({
          title: 'web-design-guidelines',
          displayPath: 'vercel-labs/agent-skills/web-design-guidelines',
        }),
        expect.objectContaining({
          title: 'frontend-design',
          displayPath: 'anthropics/skills/frontend-design',
        }),
      ]);
    } finally {
      rmSync(localRepo, { recursive: true, force: true });
    }
  });

  it('does not hit the skills.sh search API for too-short queries', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createSkillsShPromptRegistryAdapter();
    const items = await adapter.scanSource({
      source: {
        descriptor: {
          id: 'skills_sh:featured',
          adapterId: 'skills_sh',
          title: 'skills.sh',
          subtitle: 'Featured',
          origin: 'built_in',
        },
        config: {},
      },
      query: 'u',
    });

    expect(items).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });


  it('ignores malformed skills.sh catalog entries before they reach clone/fetch logic', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (!url.includes('/api/search?q=design')) {
        throw new Error(`unexpected url: ${url}`);
      }
      return {
        ok: true,
        json: async () => ({
          skills: [
            { source: 'vercel-labs/agent-skills', skillId: 'web-design-guidelines', name: 'web-design-guidelines' },
            { source: 'https://evil.example/repo', skillId: 'oops', name: 'oops' },
            { source: 'owner/repo/extra', skillId: 'nested', name: 'nested' },
            { source: 'anthropics/skills', skillId: '../../etc', name: 'bad-path' },
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createSkillsShPromptRegistryAdapter();
    const items = await adapter.scanSource({
      source: {
        descriptor: {
          id: 'skills_sh:featured',
          adapterId: 'skills_sh',
          title: 'skills.sh',
          subtitle: 'Featured',
          origin: 'built_in',
        },
        config: {},
      },
      query: 'design',
    });

    expect(items).toEqual([
      expect.objectContaining({
        title: 'web-design-guidelines',
        displayPath: 'vercel-labs/agent-skills/web-design-guidelines',
      }),
    ]);
  });

  it('falls back to the sitemap when the featured homepage no longer exposes skill links', async () => {
    const localRepo = mkdtempSync(join(tmpdir(), 'happier-skills-sh-featured-fallback-'));
    try {
      mkdirSync(join(localRepo, 'skills', 'find-skills'), { recursive: true });
      writeFileSync(join(localRepo, 'skills', 'find-skills', 'SKILL.md'), '# Find skills\n', 'utf8');
      git(localRepo, ['init', '-b', 'main']);
      git(localRepo, ['add', '.']);
      git(localRepo, ['commit', '-m', 'init']);

      vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith('/sitemap.xml')) {
          return {
            ok: true,
            text: async () => await readResponseBody([
              '<urlset>',
              '<url><loc>https://skills.sh/vercel-labs/agent-skills/web-design-guidelines</loc></url>',
              '<url><loc>https://skills.sh/anthropics/skills/frontend-design</loc></url>',
              '</urlset>',
            ].join('')),
          };
        }
        return {
          ok: true,
          text: async () => '<html><body><div>homepage without skill anchors</div></body></html>',
        };
      }));

      const adapter = createSkillsShPromptRegistryAdapter();
      const items = await adapter.scanSource({
        source: {
          descriptor: {
            id: 'skills_sh:featured',
            adapterId: 'skills_sh',
            title: 'skills.sh',
            subtitle: 'Featured',
            origin: 'built_in',
          },
          config: {
            repositoryUrl: localRepo,
          },
        },
      });

      expect(items).toEqual([
        expect.objectContaining({
          title: 'web-design-guidelines',
          displayPath: 'vercel-labs/agent-skills/web-design-guidelines',
        }),
        expect.objectContaining({
          title: 'frontend-design',
          displayPath: 'anthropics/skills/frontend-design',
        }),
      ]);
    } finally {
      rmSync(localRepo, { recursive: true, force: true });
    }
  });

  it('fetches the selected skills.sh item from its underlying source repository', async () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'happier-skills-sh-root-'));
    const fallbackRepo = mkdtempSync(join(tmpdir(), 'happier-skills-sh-fallback-'));
    const repo = join(repositoryRoot, 'acme', 'skills');
    try {
      mkdirSync(join(repo, 'skills', 'qa-reviewer'), { recursive: true });
      writeFileSync(join(repo, 'skills', 'qa-reviewer', 'SKILL.md'), [
        '---',
        'name: qa-reviewer',
        'description: Review QA changes',
        '---',
        '',
        '# QA reviewer',
      ].join('\n'), 'utf8');
      writeFileSync(join(repo, 'skills', 'qa-reviewer', 'notes.txt'), 'remember me\n', 'utf8');
      git(repo, ['init', '-b', 'main']);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-m', 'init']);

      mkdirSync(join(fallbackRepo, 'skills', 'find-skills'), { recursive: true });
      writeFileSync(join(fallbackRepo, 'skills', 'find-skills', 'SKILL.md'), '# Fallback\n', 'utf8');
      git(fallbackRepo, ['init', '-b', 'main']);
      git(fallbackRepo, ['add', '.']);
      git(fallbackRepo, ['commit', '-m', 'init']);

      vi.stubEnv('HAPPIER_SKILLS_SH_GITHUB_BASE_URL', `file://${repositoryRoot}`);
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({
          skills: [{
            source: 'acme/skills',
            skillId: 'qa-reviewer',
            name: 'qa-reviewer',
          }],
        }),
      })));

      const adapter = createSkillsShPromptRegistryAdapter();
      const [item] = await adapter.scanSource({
        source: {
          descriptor: {
            id: 'skills_sh:featured',
            adapterId: 'skills_sh',
            title: 'skills.sh',
            subtitle: 'Featured',
            origin: 'built_in',
          },
          config: {
            repositoryUrl: fallbackRepo,
          },
        },
        query: 'qa',
      });

      expect(item?.itemId).toBeTruthy();

      const fetched = await adapter.fetchItem({
        source: {
          descriptor: {
            id: 'skills_sh:featured',
            adapterId: 'skills_sh',
            title: 'skills.sh',
            subtitle: 'Featured',
            origin: 'built_in',
          },
          config: {
            repositoryUrl: fallbackRepo,
          },
        },
        itemId: String(item?.itemId),
      });

      expect(fetched.ok).toBe(true);
      if (!fetched.ok) throw new Error('expected fetched item');
      expect(fetched.item.title).toBe('qa-reviewer');
      expect(fetched.item.bundleBody.entries.map((entry) => entry.path)).toEqual(['SKILL.md', 'notes.txt']);
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
      rmSync(fallbackRepo, { recursive: true, force: true });
    }
  });
});
