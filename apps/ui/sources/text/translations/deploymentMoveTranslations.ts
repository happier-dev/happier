import type { SupportedLanguage } from '../_all';

export const deploymentMoveTranslations = {
  "en": {
    "menu": "Move to another Machine…",
    "title": "Move to another Machine",
    "description": "Uses the same commit. The source stays online until the destination is healthy; its local data is retained.",
    "restriction": "Only repository apps without Domains or local data can move here.",
    "stateless": "This app has no local data to move",
    "source": "From",
    "destination": "To",
    "run": "Start Move Workflow"
  },
  "ca": {
    "menu": "Mou a una altra màquina…",
    "title": "Mou a una altra màquina",
    "description": "Utilitza el mateix commit. L’origen continua actiu fins que la destinació està bé; les dades locals es conserven.",
    "restriction": "Només aplicacions de repositori sense dominis ni dades locals.",
    "stateless": "Aquesta aplicació no té dades locals per moure",
    "source": "Des de",
    "destination": "A",
    "run": "Inicia el flux de trasllat"
  },
  "de": {
    "menu": "Auf einen anderen Rechner verschieben…",
    "title": "Auf einen anderen Rechner verschieben",
    "description": "Verwendet denselben Commit. Die Quelle läuft bis zum erfolgreichen Gesundheitscheck weiter; lokale Daten bleiben erhalten.",
    "restriction": "Hier können nur Repository-Apps ohne Domains oder lokale Daten verschoben werden.",
    "stateless": "Diese App hat keine lokalen Daten zu verschieben",
    "source": "Von",
    "destination": "Nach",
    "run": "Umzugs-Workflow starten"
  },
  "es": {
    "menu": "Mover a otra máquina…",
    "title": "Mover a otra máquina",
    "description": "Usa el mismo commit. El origen sigue activo hasta que el destino esté sano; los datos locales se conservan.",
    "restriction": "Solo aplicaciones de repositorio sin dominios ni datos locales.",
    "stateless": "Esta aplicación no tiene datos locales que mover",
    "source": "Desde",
    "destination": "A",
    "run": "Iniciar flujo de traslado"
  },
  "fr": {
    "menu": "Déplacer vers une autre machine…",
    "title": "Déplacer vers une autre machine",
    "description": "Utilise le même commit. La source reste en ligne jusqu’à ce que la destination soit saine ; les données locales sont conservées.",
    "restriction": "Réservé aux applications de dépôt sans domaines ni données locales.",
    "stateless": "Cette application n’a pas de données locales à déplacer",
    "source": "De",
    "destination": "Vers",
    "run": "Démarrer le workflow de déplacement"
  },
  "it": {
    "menu": "Sposta su un’altra macchina…",
    "title": "Sposta su un’altra macchina",
    "description": "Usa lo stesso commit. L’origine resta online finché la destinazione è sana; i dati locali vengono conservati.",
    "restriction": "Solo applicazioni da repository senza domini o dati locali.",
    "stateless": "Questa applicazione non ha dati locali da spostare",
    "source": "Da",
    "destination": "A",
    "run": "Avvia il workflow di spostamento"
  },
  "ja": {
    "menu": "別のマシンに移動…",
    "title": "別のマシンに移動",
    "description": "同じコミットを使用します。移動先の正常性が確認されるまで移動元は稼働し、ローカルデータは保持されます。",
    "restriction": "ドメインとローカルデータのないリポジトリアプリのみ対応しています。",
    "stateless": "このアプリには移動するローカルデータがありません",
    "source": "移動元",
    "destination": "移動先",
    "run": "移動ワークフローを開始"
  },
  "pl": {
    "menu": "Przenieś na inną maszynę…",
    "title": "Przenieś na inną maszynę",
    "description": "Używa tego samego commitu. Źródło działa do potwierdzenia sprawności celu; dane lokalne są zachowane.",
    "restriction": "Tylko aplikacje z repozytorium bez domen i danych lokalnych.",
    "stateless": "Ta aplikacja nie ma danych lokalnych do przeniesienia",
    "source": "Z",
    "destination": "Do",
    "run": "Uruchom przepływ przenoszenia"
  },
  "pt": {
    "menu": "Mover para outra máquina…",
    "title": "Mover para outra máquina",
    "description": "Usa o mesmo commit. A origem fica online até o destino estar saudável; os dados locais são mantidos.",
    "restriction": "Apenas aplicações de repositório sem domínios ou dados locais.",
    "stateless": "Esta aplicação não tem dados locais para mover",
    "source": "De",
    "destination": "Para",
    "run": "Iniciar fluxo de mudança"
  },
  "ru": {
    "menu": "Перенести на другую машину…",
    "title": "Перенести на другую машину",
    "description": "Используется тот же коммит. Источник работает до проверки нового сервера; локальные данные сохраняются.",
    "restriction": "Доступно для приложений из репозитория без доменов и локальных данных.",
    "stateless": "У приложения нет локальных данных для переноса",
    "source": "Откуда",
    "destination": "Куда",
    "run": "Запустить процесс переноса"
  },
  "zh-Hans": {
    "menu": "移至另一台机器…",
    "title": "移至另一台机器",
    "description": "使用同一提交。目标通过健康检查前，源机器会保持运行，并保留本地数据。",
    "restriction": "仅支持不含域名和本地数据的仓库应用。",
    "stateless": "此应用没有需要迁移的本地数据",
    "source": "来源",
    "destination": "目标",
    "run": "启动迁移工作流"
  },
  "zh-Hant": {
    "menu": "移至另一台機器…",
    "title": "移至另一台機器",
    "description": "使用相同提交。目標通過健康檢查前，來源機器會持續執行，並保留本機資料。",
    "restriction": "僅支援不含網域和本機資料的儲存庫應用程式。",
    "stateless": "此應用程式沒有需要移轉的本機資料",
    "source": "來源",
    "destination": "目標",
    "run": "啟動移轉工作流程"
  }
} satisfies Record<SupportedLanguage, Readonly<Record<'menu' | 'title' | 'description' | 'restriction' | 'stateless' | 'source' | 'destination' | 'run', string>>>;
