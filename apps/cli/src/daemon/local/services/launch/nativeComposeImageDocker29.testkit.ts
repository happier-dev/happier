// Recorded Docker Engine 29.9.0/containerd 2.4.1, 2026-11-17.
// docker buildx build --load --platform linux/amd64,linux/arm64 (FROM scratch).
// Full payload/archive capture: o-deploy/evidence/IMAGE-IDENTITY-166/multi-*.
export const nativeDocker29LocalBuild = {
    "inspect": [
        {
            "Id": "sha256:54b9d9f43c4bf07a06d8945ee701ac4df6e549634e2752f581b29a1080d90908",
            "RepoTags": [
                "image-identity-166:e0433bb6-fa69-4430-9799-1ff921ed1796"
            ],
            "RepoDigests": [
                "image-identity-166@sha256:54b9d9f43c4bf07a06d8945ee701ac4df6e549634e2752f581b29a1080d90908"
            ],
            "Comment": "buildkit.dockerfile.v0",
            "Config": {
                "Env": [
                    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
                ],
                "WorkingDir": "/",
                "Labels": {
                    "lane": "IMAGE-IDENTITY-166-multi"
                }
            },
            "Architecture": "amd64",
            "Os": "linux",
            "Size": 651,
            "RootFS": {
                "Type": "layers"
            },
            "Metadata": {
                "LastTagTime": "2026-11-17T00:26:25.834646818Z"
            },
            "Descriptor": {
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "digest": "sha256:54b9d9f43c4bf07a06d8945ee701ac4df6e549634e2752f581b29a1080d90908",
                "size": 645
            },
            "Identity": {
                "Build": [
                    {
                        "Ref": "opkrl58884jabtcxpigey3gup",
                        "CreatedAt": "2026-11-17T01:26:25.835192892+01:00"
                    }
                ]
            }
        }
    ],
    "platformInspect": [
        {
            "Id": "sha256:60163a9fb7be26448cc0cad66767de5563b4a557b9f112266762bdab0f8ce755",
            "RepoTags": [
                "image-identity-166:e0433bb6-fa69-4430-9799-1ff921ed1796"
            ],
            "RepoDigests": [
                "image-identity-166@sha256:54b9d9f43c4bf07a06d8945ee701ac4df6e549634e2752f581b29a1080d90908"
            ],
            "Comment": "buildkit.dockerfile.v0",
            "Config": {
                "Env": [
                    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
                ],
                "WorkingDir": "/",
                "Labels": {
                    "lane": "IMAGE-IDENTITY-166-multi"
                }
            },
            "Architecture": "amd64",
            "Os": "linux",
            "Size": 651,
            "RootFS": {
                "Type": "layers"
            },
            "Metadata": {
                "LastTagTime": "2026-11-17T00:26:25.834646818Z"
            },
            "Descriptor": {
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "digest": "sha256:60163a9fb7be26448cc0cad66767de5563b4a557b9f112266762bdab0f8ce755",
                "size": 288,
                "platform": {
                    "architecture": "amd64",
                    "os": "linux"
                }
            },
            "Identity": {
                "Build": [
                    {
                        "Ref": "opkrl58884jabtcxpigey3gup",
                        "CreatedAt": "2026-11-17T01:26:25.835192892+01:00"
                    }
                ]
            }
        }
    ],
    "entries": {
        "blobs/sha256/60163a9fb7be26448cc0cad66767de5563b4a557b9f112266762bdab0f8ce755": "{\n  \"schemaVersion\": 2,\n  \"mediaType\": \"application/vnd.oci.image.manifest.v1+json\",\n  \"config\": {\n    \"mediaType\": \"application/vnd.oci.image.config.v1+json\",\n    \"digest\": \"sha256:cdb29801fc036cb633a00f558e280432847358cf957518885537fe31a15c3ad2\",\n    \"size\": 363\n  },\n  \"layers\": null\n}",
        "blobs/sha256/cdb29801fc036cb633a00f558e280432847358cf957518885537fe31a15c3ad2": "{\"architecture\":\"amd64\",\"config\":{\"Env\":[\"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\"],\"WorkingDir\":\"/\",\"Labels\":{\"lane\":\"IMAGE-IDENTITY-166-multi\"}},\"created\":null,\"history\":[{\"created_by\":\"LABEL lane=IMAGE-IDENTITY-166-multi\",\"comment\":\"buildkit.dockerfile.v0\",\"empty_layer\":true}],\"os\":\"linux\",\"rootfs\":{\"type\":\"layers\",\"diff_ids\":null}}",
        "index.json": "{\"schemaVersion\":2,\"mediaType\":\"application/vnd.oci.image.index.v1+json\",\"manifests\":[{\"mediaType\":\"application/vnd.oci.image.manifest.v1+json\",\"digest\":\"sha256:60163a9fb7be26448cc0cad66767de5563b4a557b9f112266762bdab0f8ce755\",\"size\":288,\"annotations\":{\"io.containerd.image.name\":\"docker.io/library/image-identity-166:e0433bb6-fa69-4430-9799-1ff921ed1796\",\"org.opencontainers.image.ref.name\":\"e0433bb6-fa69-4430-9799-1ff921ed1796\"},\"platform\":{\"architecture\":\"amd64\",\"os\":\"linux\"}}]}",
        "manifest.json": "[{\"Config\":\"blobs/sha256/cdb29801fc036cb633a00f558e280432847358cf957518885537fe31a15c3ad2\",\"RepoTags\":[\"image-identity-166:e0433bb6-fa69-4430-9799-1ff921ed1796\"],\"Layers\":null}]",
        "oci-layout": "{\"imageLayoutVersion\":\"1.0.0\"}"
    }
} as const;
