-- MySQL 8.0.13+ functional keys fit the documented Happier minimum 8.0.17+.
-- One ALTER uses MySQL 8 atomic DDL rather than dropping before a later CREATE.
ALTER TABLE `ProviderAccountUsageDaySummary`
    DROP INDEX `pauds_day_idx`,
    ADD INDEX `pauds_day_idx` (
        (CASE WHEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`payload`, '$.coverage.observationCount')) AS UNSIGNED) > 0
              THEN `dayStartAt` ELSE NULL END),
        `accountId`, `recordId`
    );
-- Sweep WHERE, ORDER BY and keyset cursor must use the same CASE expression,
-- not merely coverage > 0 AND dayStartAt < cutoff: expression matching is required.
-- NULL index entries remain physically present but expr < cutoff excludes them.
