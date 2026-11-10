FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS builder

RUN apt-get update \
    && apt-get install --yes --no-install-recommends sqlite3 \
    && mkdir -p /rootfs/usr/bin /rootfs/usr/share/doc \
    && cp /usr/bin/sqlite3 /rootfs/usr/bin/sqlite3 \
    && ldd /usr/bin/sqlite3 > /tmp/sqlite3-libraries \
    && awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^\//) print $i }' /tmp/sqlite3-libraries \
        | xargs -r cp --parents --dereference --target-directory=/rootfs \
    && cp --parents /usr/share/doc/sqlite3/copyright /rootfs

FROM scratch
COPY --from=builder /rootfs/ /
ENTRYPOINT ["/usr/bin/sqlite3"]
