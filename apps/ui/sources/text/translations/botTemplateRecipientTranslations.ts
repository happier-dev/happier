import type { SupportedLanguage } from '../_all';
import { botTemplateUpdateTranslations } from './botTemplateUpdateTranslations';
import { botTemplateSetupTranslations } from './botTemplateSetupTranslations';

function copy(words: readonly string[], language: SupportedLanguage) {
    return {
        ...botTemplateUpdateTranslations[language],
        ...botTemplateSetupTranslations[language],
        makeOwn: words[0]!, create: words[1]!, source: words[2]!,
        acceptedVersion: ({ version }: { version: string }) => words[3]!.replace('{version}', () => version),
        follow: words[4]!, independentCopy: words[5]!,
        memoryRules: words[6]!, skills: words[7]!, needs: words[8]!, required: words[9]!, optional: words[10]!,
        inputs: words[11]!, executable: words[12]!, binary: words[13]!, download: words[14]!,
        releaseChanged: words[15]!, copyIntro: words[16]!,
    };
}

export const botTemplateRecipientTranslations = {
    en: copy(['Make my own', 'Create Bot', 'Template source', 'Accepted version {version}', 'Follow template updates', 'Independent copy', 'Memory rules', 'Skills', 'Needs', 'Required', 'Optional', 'Inputs', 'Executable', 'Binary · Base64', 'Download', "Template changed. Review the current version before creating your copy.", "Choose where your copy runs. Create starts your Bot with the template instructions."], 'en'),
    fr: copy(['Créer ma copie', 'Créer le Bot', 'Source du modèle', 'Version acceptée {version}', 'Suivre les mises à jour', 'Copie indépendante', 'Règles de mémoire', 'Compétences', 'Prérequis', 'Obligatoire', 'Facultatif', 'Entrées', 'Exécutable', 'Binaire · Base64', 'Télécharger', "Le modèle a changé. Vérifiez la version actuelle avant de créer votre copie.", "Choisissez où exécuter votre copie. Créer démarre votre Bot avec les instructions du modèle."], 'fr'),
    de: copy(['Eigene Kopie erstellen', 'Bot erstellen', 'Vorlagenquelle', 'Übernommene Version {version}', 'Vorlagenupdates folgen', 'Unabhängige Kopie', 'Gedächtnisregeln', 'Skills', 'Voraussetzungen', 'Erforderlich', 'Optional', 'Eingaben', 'Ausführbar', 'Binär · Base64', 'Herunterladen', "Die Vorlage wurde geändert. Prüfe die aktuelle Version vor dem Erstellen deiner Kopie.", "Wähle den Ausführungsort. Erstellen startet deinen Bot mit den Vorlagenanweisungen."], 'de'),
    es: copy(['Crear mi copia', 'Crear Bot', 'Origen de la plantilla', 'Versión aceptada {version}', 'Seguir actualizaciones', 'Copia independiente', 'Reglas de memoria', 'Habilidades', 'Requisitos', 'Obligatorio', 'Opcional', 'Entradas', 'Ejecutable', 'Binario · Base64', 'Descargar', "La plantilla cambió. Revisa la versión actual antes de crear tu copia.", "Elige dónde ejecutar tu copia. Crear inicia tu Bot con las instrucciones de la plantilla."], 'es'),
    it: copy(['Crea la mia copia', 'Crea Bot', 'Origine del modello', 'Versione accettata {version}', 'Segui gli aggiornamenti', 'Copia indipendente', 'Regole di memoria', 'Competenze', 'Requisiti', 'Obbligatorio', 'Facoltativo', 'Input', 'Eseguibile', 'Binario · Base64', 'Scarica', "Il modello è cambiato. Controlla la versione attuale prima di creare la copia.", "Scegli dove eseguire la copia. Crea avvia il Bot con le istruzioni del modello."], 'it'),
    pt: copy(['Criar a minha cópia', 'Criar Bot', 'Origem do modelo', 'Versão aceite {version}', 'Seguir atualizações', 'Cópia independente', 'Regras de memória', 'Competências', 'Requisitos', 'Obrigatório', 'Opcional', 'Entradas', 'Executável', 'Binário · Base64', 'Transferir', "O modelo mudou. Revê a versão atual antes de criar a tua cópia.", "Escolhe onde executar a cópia. Criar inicia o Bot com as instruções do modelo."], 'pt'),
    ca: copy(['Crea la meva còpia', 'Crea el Bot', 'Origen de la plantilla', 'Versió acceptada {version}', 'Segueix les actualitzacions', 'Còpia independent', 'Regles de memòria', 'Habilitats', 'Requisits', 'Obligatori', 'Opcional', 'Entrades', 'Executable', 'Binari · Base64', 'Baixa', "La plantilla ha canviat. Revisa la versió actual abans de crear la còpia.", "Tria on executar la còpia. Crea inicia el Bot amb les instruccions de la plantilla."], 'ca'),
    ja: copy(['自分のコピーを作成', 'Botを作成', 'テンプレートのソース', '採用バージョン {version}', '更新をフォロー', '独立したコピー', 'メモリルール', 'スキル', '必要なもの', '必須', '任意', '入力', '実行可能', 'バイナリ · Base64', 'ダウンロード', "テンプレートが変更されました。コピーを作成する前に現在のバージョンを確認してください。", "コピーの実行場所を選んでください。作成するとテンプレートの指示でBotが開始します。"], 'ja'),
    ru: copy(['Создать свою копию', 'Создать бота', 'Источник шаблона', 'Принята версия {version}', 'Следить за обновлениями', 'Независимая копия', 'Правила памяти', 'Навыки', 'Требования', 'Обязательно', 'Необязательно', 'Входные данные', 'Исполняемый', 'Двоичный · Base64', 'Скачать', "Шаблон изменился. Проверьте текущую версию перед созданием копии.", "Выберите место запуска копии. Создание запускает бота с инструкциями шаблона."], 'ru'),
    pl: copy(['Utwórz własną kopię', 'Utwórz bota', 'Źródło szablonu', 'Przyjęta wersja {version}', 'Śledź aktualizacje', 'Niezależna kopia', 'Reguły pamięci', 'Umiejętności', 'Wymagania', 'Wymagane', 'Opcjonalne', 'Dane wejściowe', 'Wykonywalny', 'Binarny · Base64', 'Pobierz', "Szablon się zmienił. Sprawdź bieżącą wersję przed utworzeniem kopii.", "Wybierz miejsce uruchomienia kopii. Utwórz uruchamia bota z instrukcjami szablonu."], 'pl'),
    'zh-Hans': copy(['创建我的副本', '创建Bot', '模板来源', '已接受版本 {version}', '关注模板更新', '独立副本', '记忆规则', '技能', '需求', '必需', '可选', '输入', '可执行', '二进制 · Base64', '下载', "模板已更改。创建副本前请查看当前版本。", "选择副本的运行位置。创建后，Bot将按照模板指令启动。"], 'zh-Hans'),
    'zh-Hant': copy(['建立我的副本', '建立Bot', '範本來源', '已接受版本 {version}', '追蹤範本更新', '獨立副本', '記憶規則', '技能', '需求', '必要', '選用', '輸入', '可執行', '二進位 · Base64', '下載', "範本已變更。建立副本前請查看目前版本。", "選擇副本的執行位置。建立後，Bot將按照範本指令啟動。"], 'zh-Hant'),
} satisfies Record<SupportedLanguage, ReturnType<typeof copy>>;
