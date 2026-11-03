import type { SupportedLanguage } from '../_all';

function copy(words: readonly [string, string, string, string, string, string, string]) {
    return { signedInLink: words[0], signedInLinkDescription: words[1], signedInLinkKeepsAccess: words[2],
        canCopy: words[3], signInRequired: words[4], reopenLink: words[5], encryptedAccountRequired: words[6] };
}

export const botTemplateSharingTranslations = {
    en: copy(['Signed-in link', 'Anyone who signs in to this server with the link can copy this template.', 'Turning off or replacing the link stops new joins. People who already joined keep access until you remove them.', 'Can copy', 'Sign in to this server, then reopen the original link.', "Reopen the original link to try again.", "Open this link with an encrypted Account."]),
    fr: copy(['Lien avec connexion', 'Toute personne connectée à ce serveur avec le lien peut copier ce modèle.', 'Désactiver ou remplacer le lien empêche les nouveaux accès. Les personnes déjà inscrites conservent leur accès jusqu’à leur retrait.', 'Peut copier', 'Connectez-vous à ce serveur, puis rouvrez le lien original.', "Rouvrez le lien original pour réessayer.", "Ouvrez ce lien avec un compte chiffré."]),
    de: copy(['Link mit Anmeldung', 'Wer sich mit dem Link an diesem Server anmeldet, kann diese Vorlage kopieren.', 'Deaktivieren oder Ersetzen verhindert neue Beitritte. Bereits beigetretene Personen behalten Zugriff, bis du sie entfernst.', 'Darf kopieren', 'Melde dich an diesem Server an und öffne dann den ursprünglichen Link erneut.', "Öffne den ursprünglichen Link erneut, um es noch einmal zu versuchen.", "Öffne diesen Link mit einem verschlüsselten Konto."]),
    es: copy(['Enlace con inicio de sesión', 'Cualquiera que inicie sesión en este servidor con el enlace puede copiar esta plantilla.', 'Desactivar o reemplazar el enlace impide nuevos accesos. Quienes ya accedieron conservan el acceso hasta que los elimines.', 'Puede copiar', 'Inicia sesión en este servidor y vuelve a abrir el enlace original.', "Vuelve a abrir el enlace original para intentarlo de nuevo.", "Abre este enlace con una cuenta cifrada."]),
    it: copy(['Link con accesso', 'Chiunque acceda a questo server con il link può copiare questo modello.', 'Disattivare o sostituire il link impedisce nuovi accessi. Chi è già entrato mantiene l’accesso finché non lo rimuovi.', 'Può copiare', 'Accedi a questo server, poi riapri il link originale.', "Riapri il link originale per riprovare.", "Apri questo link con un account crittografato."]),
    pt: copy(['Ligação com início de sessão', 'Qualquer pessoa que inicie sessão neste servidor com a ligação pode copiar este modelo.', 'Desativar ou substituir a ligação impede novas entradas. Quem já entrou mantém o acesso até ser removido.', 'Pode copiar', 'Inicia sessão neste servidor e volta a abrir a ligação original.', "Volta a abrir a ligação original para tentar novamente.", "Abre esta ligação com uma conta encriptada."]),
    ca: copy(['Enllaç amb inici de sessió', 'Qualsevol persona que iniciï sessió en aquest servidor amb l’enllaç pot copiar aquesta plantilla.', 'Desactivar o substituir l’enllaç impedeix noves entrades. Qui ja ha entrat conserva l’accés fins que l’eliminis.', 'Pot copiar', 'Inicia sessió en aquest servidor i torna a obrir l’enllaç original.', "Torna a obrir l’enllaç original per tornar-ho a provar.", "Obre aquest enllaç amb un compte xifrat."]),
    ja: copy(['ログイン用リンク', 'このリンクでこのサーバーにログインした人は、このテンプレートをコピーできます。', 'リンクの無効化や更新は新規参加を停止します。参加済みの人は削除されるまでアクセスを保持します。', 'コピー可能', 'このサーバーにログインして、元のリンクを開き直してください。', "再試行するには、元のリンクを開き直してください。", "暗号化されたアカウントでこのリンクを開いてください。"]),
    ru: copy(['Ссылка со входом', 'Любой, кто войдёт на этот сервер по ссылке, сможет скопировать шаблон.', 'Отключение или замена ссылки запрещает новые подключения. Подключившиеся сохраняют доступ, пока вы их не удалите.', 'Может копировать', 'Войдите на этот сервер и снова откройте исходную ссылку.', "Чтобы повторить попытку, снова откройте исходную ссылку.", "Откройте эту ссылку из зашифрованного аккаунта."]),
    pl: copy(['Link wymagający logowania', 'Każdy, kto zaloguje się na tym serwerze z linkiem, może skopiować szablon.', 'Wyłączenie lub zastąpienie linku blokuje nowe dołączenia. Osoby już dołączone zachowują dostęp do czasu ich usunięcia.', 'Może kopiować', 'Zaloguj się na tym serwerze i ponownie otwórz oryginalny link.', "Otwórz ponownie oryginalny link, aby spróbować jeszcze raz.", "Otwórz ten link za pomocą szyfrowanego konta."]),
    'zh-Hans': copy(['需登录的链接', '任何通过此链接登录本服务器的人都可以复制此模板。', '关闭或替换链接会阻止新用户加入。已加入的人会保留访问权限，直到你将其移除。', '可复制', '请登录此服务器，然后重新打开原始链接。', "请重新打开原始链接以重试。", "请使用加密帐户打开此链接。"]),
    'zh-Hant': copy(['需登入的連結', '任何透過此連結登入本伺服器的人都可以複製此範本。', '關閉或替換連結會阻止新使用者加入。已加入的人會保留存取權限，直到你將其移除。', '可複製', '請登入此伺服器，然後重新開啟原始連結。', "請重新開啟原始連結以重試。", "請使用加密帳戶開啟此連結。"]),
} satisfies Record<SupportedLanguage, ReturnType<typeof copy>>;

function versionReports(words: readonly [string, string, string]) {
    return {
        acceptedVersionReport: ({ version, copies }: { version: string; copies: number }) =>
            words[0].replace('{version}', () => version).replace('{copies}', () => String(copies)),
        noVersionReported: words[1],
        versionReportsUnavailable: words[2],
    };
}

export const botTemplateVersionReportTranslations = {
    en: versionReports(['Last reported {version} · copies: {copies}', 'No version reported', 'Version reports unavailable']),
    fr: versionReports(['Dernier rapport : {version} · copies : {copies}', 'Aucune version signalée', 'Rapports de version indisponibles']),
    de: versionReports(['Zuletzt gemeldet: {version} · Kopien: {copies}', 'Keine Version gemeldet', 'Versionsmeldungen nicht verfügbar']),
    es: versionReports(['Último informe: {version} · copias: {copies}', 'No se ha informado de ninguna versión', 'Informes de versión no disponibles']),
    it: versionReports(['Ultima versione segnalata: {version} · copie: {copies}', 'Nessuna versione segnalata', 'Segnalazioni di versione non disponibili']),
    pt: versionReports(['Última versão comunicada: {version} · cópias: {copies}', 'Nenhuma versão comunicada', 'Relatórios de versão indisponíveis']),
    ca: versionReports(['Últim informe: {version} · còpies: {copies}', 'No s’ha informat de cap versió', 'Informes de versió no disponibles']),
    ja: versionReports(['最終報告 {version} · コピー数: {copies}', 'バージョン報告なし', 'バージョン報告を利用できません']),
    ru: versionReports(['Последняя отметка: {version} · копий: {copies}', 'Версия не сообщена', 'Отметки версий недоступны']),
    pl: versionReports(['Ostatnio zgłoszono {version} · kopie: {copies}', 'Nie zgłoszono wersji', 'Zgłoszenia wersji niedostępne']),
    'zh-Hans': versionReports(['上次报告 {version} · 副本数：{copies}', '尚未报告版本', '版本报告不可用']),
    'zh-Hant': versionReports(['上次回報 {version} · 副本數：{copies}', '尚未回報版本', '版本回報無法使用']),
} satisfies Record<SupportedLanguage, ReturnType<typeof versionReports>>;
