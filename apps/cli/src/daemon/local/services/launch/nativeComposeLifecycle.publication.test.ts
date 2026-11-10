import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { nativeBuildFixtureDigest as digest, withNativeComposeBuildFixture as withBuilder,
    withNativeComposeBuildAdmission as admitted } from './nativeComposeBuild.testkit';

describe('admitted native registry publication', () => {
    it('publishes the same built CONFIGs and actual variants into one index per declared repository without rebuilding', async () => {
        await withBuilder(async ({ project, requests, expected }) => {
            await admitted(project, async context => {
                const { images } = await project.prepareImages({ context, platforms: ['linux/amd64', 'linux/arm64'],
                    build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } });
                expect(images).toHaveLength(4);
                for (const image of images) {
                    expect(image.configDigest).toBe(expected.get(`${image.service}/${image.platform}`)?.configDigest);
                    expect(image.manifestDigest).not.toBe(expected.get(`${image.service}/${image.platform}`)?.manifestDigest);
                    expect(image.registryReference).toBe(`registry.example.test/${image.service}@${image.manifestDigest}`);
                    expect(image.indexDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
                }
                for (const service of ['web', 'worker']) expect(new Set(images.filter(image => image.service === service)
                    .map(image => image.indexDigest)).size).toBe(1);
                expect(requests.filter(request => request.args[0] === 'buildx' && request.args[1] === 'bake' && !request.args.includes('--print'))).toHaveLength(2);
                expect(requests.filter(request => request.args[0] === 'image' && request.args[1] === 'push')).toHaveLength(4);
                expect(requests.filter(request => request.args[0] === 'buildx' && request.args[2] === 'create')).toHaveLength(2);
                const archives = await project.exportImages({ images, context });
                expect(archives).toHaveLength(4);
                for (const archive of archives) expect(archive.sha256).toBe(digest(await readFile(archive.path)).slice(7));
            });
        }, { publication: 'ok' });
    });

    it.each(['missingRepository', 'secretRepository'] as const)('refuses %s without guessing or disclosing a registry destination', async publication => {
        await withBuilder(async ({ project, requests }) => {
            await admitted(project, async context => {
                await expect(project.prepareImages({ context, platforms: ['linux/amd64'],
                    build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } }))
                    .rejects.toMatchObject({ code: 'invalid_request', details: { reason: publication === 'missingRepository'
                        ? 'deployment_registry_repository_required' : 'secret_registry_repository' } });
                expect(requests.some(request => request.args[1] === 'push' || request.args[2] === 'create')).toBe(false);
            });
        }, { publication });
    });

    it('finishes admitted registry publication without reidentifying its engine per command', async () => {
        await withBuilder(async ({ project, requests }) => {
            await admitted(project, async context => {
                const before = requests.filter(request => request.args.includes('info')).length;
                const { images } = await project.prepareImages({ context, platforms: ['linux/amd64'],
                    build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } });
                expect(images).toHaveLength(2);
                expect(requests.filter(request => request.args.includes('info'))).toHaveLength(before);
                expect(requests.filter(request => request.args[0] === 'image' && request.args[1] === 'push')).toHaveLength(2);
            });
        }, { publication: 'engineMismatch' });
    });

    it('finishes publication with its admitted credentials after the resource catalog changes', async () => {
        await withBuilder(async ({ project, expected, requests }) => {
            await admitted(project, async context => {
                const { images } = await project.prepareImages({ context, platforms: ['linux/amd64', 'linux/arm64'],
                    build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } });
                expect(images).toHaveLength(4);
                for (const image of images) {
                    expect(image.configDigest).toBe(expected.get(`${image.service}/${image.platform}`)?.configDigest);
                    expect(image.indexDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
                    expect(image.registryReference).toContain(`registry.example.test/${image.service}@`);
                }
                expect(requests.some(request => request.args[2] === 'create')).toBe(true);
            });
        }, { publication: 'resourceChanged' });
    });

    it.each(['pushFailure', 'tamperedIndex'] as const)('does not downgrade %s publication to archives', async publication => {
        await withBuilder(async ({ project, requests }) => {
            await admitted(project, async context => {
                await expect(project.prepareImages({ context, platforms: ['linux/amd64', 'linux/arm64'],
                    build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } }))
                    .rejects.toMatchObject({ code: 'native_failed', details: { reason: publication === 'pushFailure'
                            ? 'native_compose_command_failed' : 'deployment_image_manifest_mismatch' } });
                if (publication !== 'tamperedIndex') expect(requests.some(request => request.args[2] === 'create')).toBe(false);
                expect(requests.some(request => request.args.includes('up'))).toBe(false);
            });
        }, { publication });
    });
});
